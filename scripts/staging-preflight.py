"""Read-only AWS checks before an Aqua Card staging recovery exercise."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import sys

REGION = "ap-northeast-2"
NAMESPACE = "AquaCard/Operations"
MONITOR_LOOKBACK = timedelta(minutes=15)  # Three scheduled monitor intervals.
BASE_ALARMS = {
    "MissingMonitorAlarm": {"MonitorHealthy"},
    "MonitorErrorAlarm": {"MonitorHealthy"},
    "RewardBudgetAlarm": {"RewardBudgetLow"},
    "CashbackSkippedAlarm": {"UnfundedCashbackAuthorizations24h"},
    "LedgerAlarm": {"LedgerFindings"},
    "OldestDueAlarm": {q + "OldestDueSeconds" for q in ("CardInbox", "IssuerOutbox", "AuthMail")},
    "ReviewAlarm": {"CardInboxReviewCount", "IssuerOutboxReviewCount"},
    "QueueFailureAlarm": {q + "FailureCount" for q in ("CardInbox", "IssuerOutbox", "AuthMail")},
    "BlockedCardAlarm": {"CardInboxBlockedCount"},
}
WORKER_ALARMS = {
    "CardWorkerExpected": ("CardWorkerAlarm", "CardWorkerHeartbeat"),
    "IssuerDispatcherExpected": ("IssuerDispatcherAlarm", "IssuerDispatcherHeartbeat"),
    "AuthMailWorkerExpected": ("AuthMailWorkerAlarm", "AuthMailWorkerHeartbeat"),
}


class Unavailable(Exception):
    """A short fixed code, never CLI output or a provider error message."""


def aws(service, operation, *args, query):
    cmd = ["aws", service, operation, *args, "--region", REGION, "--query", query,
           "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "10"]
    env = {**os.environ, "AWS_MAX_ATTEMPTS": "2", "AWS_CLI_AUTO_PROMPT": "off",
           "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true"}
    try:
        result = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=30, check=True)
        return json.loads(result.stdout)
    except FileNotFoundError:
        raise Unavailable("aws_cli_unavailable") from None
    except (OSError, ValueError, subprocess.SubprocessError):
        raise Unavailable(f"{service}.{operation}") from None


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        raise ValueError("utc_time")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def valid_inputs(args, now):
    return (re.fullmatch(r"[0-9]{12}", args.account)
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,127}", args.stack)
            and re.fullmatch(r"[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?", args.environment)
            and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", args.db_instance)
            and "--" not in args.db_instance and not args.db_instance.endswith("-")
            and re.fullmatch(rf"arn:aws:sns:{REGION}:{args.account}:[\w-]{{1,256}}", args.topic_arn, re.ASCII)
            and timestamp(args.restore_time) <= now)


def check_rds(call, args, report):
    identifier = args.db_instance
    instances = call("rds", "describe-db-instances", "--db-instance-identifier", identifier,
                     query="DBInstances[].{id:DBInstanceIdentifier,arn:DBInstanceArn,resource:DbiResourceId,"
                           "status:DBInstanceStatus,engine:Engine,public:PubliclyAccessible,"
                           "encrypted:StorageEncrypted,retention:BackupRetentionPeriod,cluster:DBClusterIdentifier}")
    arn = f"arn:aws:rds:{REGION}:{args.account}:db:{identifier}"
    if len(instances) != 1 or instances[0]["arn"] != arn or instances[0]["id"] != identifier:
        report["blockers"].append("rds_instance_mismatch")
        return
    db = instances[0]
    fields = {"available": db["status"] == "available", "postgresInstance": db["engine"] == "postgres" and not db["cluster"],
              "private": db["public"] is False, "encrypted": db["encrypted"] is True,
              "backupsEnabled": type(db["retention"]) is int and db["retention"] > 0}
    report["database"] = fields
    if not all(fields.values()):
        report["blockers"].append("rds_configuration")
    if not db["resource"]:
        raise Unavailable("rds.resource_id")
    backups = call("rds", "describe-db-instance-automated-backups", "--dbi-resource-id", db["resource"],
                   query="DBInstanceAutomatedBackups[].{resource:DbiResourceId,arn:DBInstanceArn,region:Region,"
                         "status:Status,window:RestoreWindow}")
    active = [item for item in backups if item["resource"] == db["resource"] and item["arn"] == arn
              and item["region"] == REGION and item["status"] == "active"]
    if len(active) != 1 or not active[0]["window"]:
        report["blockers"].append("active_restore_window_unavailable")
        return
    report["sourceDbiResourceId"] = db["resource"]
    window = active[0]["window"]
    earliest, latest = timestamp(window["EarliestTime"]), timestamp(window["LatestTime"])
    report["restoreWindow"] = {"earliest": iso(earliest), "latest": iso(latest)}
    if not earliest <= timestamp(args.restore_time) < latest:
        report["blockers"].append("target_outside_restore_window")


def alarm_metrics(alarm, environment):
    # Simple alarms attach a metric directly. Expressions reference MetricStat inputs.
    inputs = [row["MetricStat"]["Metric"] for row in alarm["Metrics"] if "MetricStat" in row] if alarm["Metrics"] else [alarm]
    dimensions = [{"Name": "Environment", "Value": environment}]
    if any(metric["Namespace"] != NAMESPACE or metric["Dimensions"] != dimensions for metric in inputs):
        return set()
    return {metric["MetricName"] for metric in inputs}


def check_alarms(call, args, expected, stack_arn, report):
    rows = call("cloudformation", "list-stack-resources", "--stack-name", stack_arn,
                query="StackResourceSummaries[?ResourceType=='AWS::CloudWatch::Alarm']."
                      "{logical:LogicalResourceId,physical:PhysicalResourceId}")
    physical = {row["logical"]: row["physical"] for row in rows}
    if set(physical) != set(expected) or len(set(physical.values())) != len(expected) or not all(physical.values()):
        report["blockers"].append("stack_alarm_set_mismatch")
        return
    alarms = call("cloudwatch", "describe-alarms", "--alarm-names", *physical.values(),
                  query="MetricAlarms[].{name:AlarmName,state:StateValue,evaluation:EvaluationState,enabled:ActionsEnabled,"
                        "actions:AlarmActions,recovery:OKActions,MetricName:MetricName,Namespace:Namespace,"
                        "Dimensions:Dimensions,Metrics:Metrics,stat:Statistic,period:Period,evaluations:EvaluationPeriods,"
                        "required:DatapointsToAlarm,threshold:Threshold,operator:ComparisonOperator,missing:TreatMissingData}")
    by_name = {item["name"]: item for item in alarms}
    states = {}
    report["alarms"] = states
    for logical, name in physical.items():
        item = by_name.get(name)
        if not item:
            states[logical] = "MISSING"
            report["blockers"].append(logical + ".missing")
            continue
        state = item["state"]
        states[logical] = state if state in ("OK", "ALARM", "INSUFFICIENT_DATA") else "UNKNOWN"
        if state != "OK" or item["evaluation"] is not None:
            report["blockers"].append(logical + ".state")
        if item["enabled"] is not True or item["actions"] != [args.topic_arn] or item["recovery"] != [args.topic_arn]:
            report["blockers"].append(logical + ".notification_route")
        if logical == "MissingMonitorAlarm" and (
                item["stat"] != "SampleCount" or item["period"] != 300 or item["evaluations"] != 3
                or item["required"] not in (None, 3) or item["threshold"] != 1
                or item["operator"] != "LessThanThreshold" or item["missing"] != "breaching"):
            report["blockers"].append(logical + ".detection")
        if alarm_metrics(item, args.environment) != expected[logical]:
            report["blockers"].append(logical + ".metric")

    active_mutes = call("cloudwatch", "list-alarm-mute-rules", "--alarm-name", physical["MissingMonitorAlarm"],
                        "--statuses", "ACTIVE", query="length(AlarmMuteRuleSummaries)")
    if type(active_mutes) is not int or active_mutes < 0:
        raise Unavailable("cloudwatch.mute_rules")
    if active_mutes:
        report["blockers"].append("MissingMonitorAlarm.muted")


def check_monitor(call, args, now, report):
    stacks = call("cloudformation", "describe-stacks", "--stack-name", args.stack,
                  query="Stacks[].{id:StackId,status:StackStatus,parameters:Parameters,outputs:Outputs}")
    if len(stacks) != 1 or not stacks[0]["id"].startswith(
            f"arn:aws:cloudformation:{REGION}:{args.account}:stack/{args.stack}/"):
        report["blockers"].append("stack_mismatch")
        return
    stack = stacks[0]
    params = {p["ParameterKey"]: p["ParameterValue"] for p in stack["parameters"]}
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stack["outputs"] or []}
    if stack["status"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"):
        report["blockers"].append("stack_unstable")
    if params.get("Environment") != args.environment or params.get("AlarmTopicArn") != args.topic_arn:
        report["blockers"].append("stack_environment_or_topic_mismatch")
        return
    expected = BASE_ALARMS.copy()
    for param, (logical, metric) in WORKER_ALARMS.items():
        if params.get(param) not in ("true", "false"):
            report["blockers"].append("stack_worker_configuration")
            return
        if params[param] == "true":
            expected[logical] = {metric}

    match = re.fullmatch(rf"arn:aws:scheduler:{REGION}:{args.account}:schedule/([\w.-]+)/([\w.-]+)",
                         outputs.get("MonitorScheduleArn", ""), re.ASCII)
    if not match:
        report["blockers"].append("stack_schedule_missing")
    else:
        schedule = call("scheduler", "get-schedule", "--group-name", match[1], "--name", match[2],
                        query="{enabled:State,rate:ScheduleExpression,start:StartDate,end:EndDate,cluster:Target.Arn,"
                              "task:Target.EcsParameters.TaskDefinitionArn,"
                              "public:Target.EcsParameters.NetworkConfiguration.awsvpcConfiguration.AssignPublicIp}")
        if (schedule["enabled"] != "ENABLED" or schedule["rate"] != "rate(5 minutes)"
                or (schedule["start"] and timestamp(schedule["start"]) > now)
                or (schedule["end"] and timestamp(schedule["end"]) <= now)
                or not params.get("ClusterArn") or schedule["cluster"] != params["ClusterArn"]
                or not outputs.get("MonitorTaskDefinitionArn") or schedule["task"] != outputs["MonitorTaskDefinitionArn"]
                or schedule["public"] != "DISABLED"):
            report["blockers"].append("schedule_configuration")
    check_alarms(call, args, expected, stack["id"], report)

    count = call("sns", "get-topic-attributes", "--topic-arn", args.topic_arn, query="Attributes.SubscriptionsConfirmed")
    if not isinstance(count, str) or not count.isascii() or not count.isdecimal():
        raise Unavailable("sns.subscription_count")
    report["confirmedSubscriptions"] = int(count)
    if not int(count):
        report["blockers"].append("no_confirmed_subscription")
    since = now - MONITOR_LOOKBACK
    points = call("cloudwatch", "get-metric-statistics", "--namespace", NAMESPACE, "--metric-name", "MonitorHealthy",
                  "--dimensions", f"Name=Environment,Value={args.environment}", "--start-time", iso(since),
                  "--end-time", iso(now), "--period", "60", "--statistics", "Minimum", "--unit", "Count",
                  query="Datapoints[].{time:Timestamp,minimum:Minimum}")
    current = sorted((timestamp(p["time"]), p["minimum"]) for p in points if since <= timestamp(p["time"]) <= now)
    if not current:
        report["blockers"].append("monitor_no_recent_sample")
    else:
        sample, minimum = current[-1]
        report["monitorSampleUtc"] = iso(sample)
        if minimum != 1:
            report["blockers"].append("monitor_last_sample_unhealthy")


def run(args, call=aws, now=None):
    now = now or datetime.now(timezone.utc)
    report = {"region": REGION, "checkedAt": iso(now), "blockers": [],
              "humanNotificationReceipt": "unverified", "managedRestore": "unverified", "monitorDatabaseBinding": "unverified"}
    try:
        if not valid_inputs(args, now):
            raise ValueError()
        report.update({"environment": args.environment, "dbInstance": args.db_instance, "stack": args.stack,
                       "restoreTargetUtc": iso(timestamp(args.restore_time))})
    except ValueError:
        return 2, {**report, "status": "unavailable", "error": "invalid_inputs"}
    try:
        if call("sts", "get-caller-identity", query="Account") != args.account:
            report["blockers"].append("account_mismatch")
        else:
            check_rds(call, args, report)
            check_monitor(call, args, now, report)
    except Unavailable as exc:
        return 2, {**report, "status": "unavailable", "error": str(exc)}
    except (TypeError, KeyError, AttributeError, ValueError, IndexError):
        return 2, {**report, "status": "unavailable", "error": "incomplete_aws_response"}
    if report["blockers"]:
        return 1, {**report, "status": "blocked"}
    return 0, {**report, "status": "ready_for_drill"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("account", "stack", "environment", "db-instance", "topic-arn", "restore-time"):
        parser.add_argument("--" + arg, required=True)
    code, report = run(parser.parse_args())
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(code)
