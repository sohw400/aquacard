import argparse
from copy import deepcopy
from datetime import timedelta
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("staging_preflight", Path(__file__).with_name("staging-preflight.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

NOW = preflight.timestamp("2026-11-26T05:00:00Z")
ACCOUNT = "123456789012"
REGION = "ap-northeast-2"
TOPIC = f"arn:aws:sns:{REGION}:{ACCOUNT}:drill"
DB_ARN = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:staging-db"


def args():
    return argparse.Namespace(account=ACCOUNT, stack="staging-monitor", environment="kr-staging",
                              db_instance="staging-db", topic_arn=TOPIC, restore_time="2026-11-26T04:00:00Z")


class Responses:
    """Projected AWS CLI responses including every alarm from the deployed stack."""
    def __init__(self):
        stack_id = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/staging-monitor/example-id"
        schedule = f"arn:aws:scheduler:{REGION}:{ACCOUNT}:schedule/group/sched"
        cluster = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/staging"
        task = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/staging:9"
        params = {"Environment": "kr-staging", "AlarmTopicArn": TOPIC, "ClusterArn": cluster,
                  "CardWorkerExpected": "true", "IssuerDispatcherExpected": "false", "AuthMailWorkerExpected": "false"}
        outputs = {"MonitorScheduleArn": schedule, "MonitorTaskDefinitionArn": task}
        self.calls = []
        self.records = {
            "get-caller-identity": ACCOUNT,
            "describe-stacks": [{"id": stack_id, "status": "UPDATE_COMPLETE",
                                 "parameters": [{"ParameterKey": k, "ParameterValue": v} for k, v in params.items()],
                                 "outputs": [{"OutputKey": k, "OutputValue": v} for k, v in outputs.items()]}],
            "describe-db-instances": [{"id": "staging-db", "arn": DB_ARN, "resource": "db-ABCDEF", "public": False,
                                       "status": "available", "engine": "postgres", "retention": 7, "encrypted": True,
                                       "cluster": None}],
            "describe-db-instance-automated-backups": [{"arn": DB_ARN, "resource": "db-ABCDEF", "status": "active",
                                                       "region": REGION, "window": {
                                                           "EarliestTime": "2026-11-21T05:00:00+00:00",
                                                           "LatestTime": "2026-11-26T04:55:00+00:00"}}],
            "get-schedule": {"enabled": "ENABLED", "rate": "rate(5 minutes)", "cluster": cluster, "task": task,
                             "public": "DISABLED", "start": None, "end": None},
            "get-topic-attributes": "2", "list-alarm-mute-rules": 0,
            "get-metric-statistics": [{"time": "2026-11-26T04:58:00Z", "minimum": 1.0},
                                      {"time": "2026-11-26T04:53:00Z", "minimum": 0.0}],
            "list-stack-resources": [], "describe-alarms": [],
        }
        expected = {**preflight.BASE_ALARMS, "CardWorkerAlarm": {"CardWorkerHeartbeat"}}
        for logical, metrics in expected.items():
            name = "random-resource-" + logical
            self.records["list-stack-resources"].append({"logical": logical, "physical": name})
            dimensions = [{"Name": "Environment", "Value": "kr-staging"}]
            sources = [{"MetricName": metric, "Namespace": preflight.NAMESPACE, "Dimensions": dimensions}
                       for metric in metrics]
            alarm = {"name": name, "state": "OK", "enabled": True, "evaluation": None, "actions": [TOPIC], "recovery": [TOPIC]}
            if logical == "MissingMonitorAlarm":
                alarm.update(stat="SampleCount", period=300, evaluations=3, required=None, threshold=1,
                             operator="LessThanThreshold", missing="breaching")
            if len(sources) == 1:
                alarm.update(sources[0], Metrics=None)
            else:
                alarm["Metrics"] = [{"Expression": "MAX(METRICS())"}] + [
                    {"MetricStat": {"Metric": source}} for source in sources]
            self.records["describe-alarms"].append(alarm)

    def __call__(self, service, operation, *arguments, query):
        self.calls.append((service, operation, arguments, query))
        return self.records[operation]


class StagingPreflightTests(unittest.TestCase):
    def test_uses_native_backup_record_stack_physical_alarms_and_aggregate_subscription_count(self):
        data = Responses()
        code, report = preflight.run(args(), data, NOW)
        self.assertEqual(0, code, report)
        self.assertEqual(("unverified", "unverified"), (report["humanNotificationReceipt"], report["managedRestore"]))
        self.assertEqual("db-ABCDEF", report["sourceDbiResourceId"])
        self.assertEqual("2026-11-26T04:55:00Z", report["restoreWindow"]["latest"])
        self.assertEqual("2026-11-26T04:58:00Z", report["monitorSampleUtc"])
        self.assertEqual(8, len(report["alarms"]))
        calls = {op: (arguments, query) for _, op, arguments, query in data.calls}
        self.assertEqual(("--dbi-resource-id", "db-ABCDEF"), calls["describe-db-instance-automated-backups"][0])
        actual_names = {row["physical"] for row in data.records["list-stack-resources"]}
        self.assertEqual(actual_names, set(calls["describe-alarms"][0][1:]))
        self.assertEqual("Attributes.SubscriptionsConfirmed", calls["get-topic-attributes"][1])
        self.assertEqual(("--group-name", "group", "--name", "sched"), calls["get-schedule"][0])

    def test_validates_input_before_aws_and_stops_on_wrong_identity(self):
        for key, value in [("account", "123"), ("restore_time", "2026-11-26"),
                           ("restore_time", "2026-11-26T18:00:00+09:00"), ("topic_arn", TOPIC.replace(REGION, "us-east-1")),
                           ("restore_time", "2026-11-26T07:00:00Z"), ("db_instance", "--bad")]:
            with self.subTest(key=key, value=value):
                target, data = args(), Responses()
                setattr(target, key, value)
                self.assertEqual(2, preflight.run(target, data, NOW)[0])
                self.assertEqual([], data.calls)
        data = Responses()
        data.records["get-caller-identity"] = "222222222222"
        self.assertEqual(["account_mismatch"], preflight.run(args(), data, NOW)[1]["blockers"])
        self.assertEqual(1, len(data.calls))

    def test_restore_window_bounds_and_original_source_identity(self):
        for key, value in [("resource", "db-OTHER"), ("arn", DB_ARN + "x"), ("status", "retained"),
                           ("region", "us-east-1"), ("window", None)]:
            with self.subTest(key=key):
                data = Responses()
                data.records["describe-db-instance-automated-backups"][0][key] = value
                code, report = preflight.run(args(), data, NOW)
                self.assertEqual(1, code)
                self.assertIn("active_restore_window_unavailable", report["blockers"])
        for time, expected in [("2026-11-21T05:00:00Z", 0), ("2026-11-26T04:54:59.999999Z", 0), ("2026-11-26T04:55:00Z", 1),
                               ("2026-11-21T04:59:59Z", 1), ("2026-11-26T04:55:00.001Z", 1)]:
            data, target = Responses(), args()
            target.restore_time = time
            self.assertEqual(expected, preflight.run(target, data, NOW)[0])

    def test_rejects_unusable_instance_and_failed_or_missing_monitor_datapoints(self):
        for key, value in [("encrypted", False), ("public", True), ("status", "stopped"), ("retention", 0),
                           ("engine", "mysql"), ("cluster", "multi-az-cluster"), ("public", None)]:
            with self.subTest(key=key):
                data = Responses()
                data.records["describe-db-instances"][0][key] = value
                self.assertIn("rds_configuration", preflight.run(args(), data, NOW)[1]["blockers"])
        for age, value, blocker in [(1, 0, "monitor_last_sample_unhealthy"), (16, 1, "monitor_no_recent_sample"),
                                    (-1, 1, "monitor_no_recent_sample")]:
            data = Responses()
            data.records["get-metric-statistics"] = [{"time": preflight.iso(NOW - timedelta(minutes=age)), "minimum": value}]
            self.assertIn(blocker, preflight.run(args(), data, NOW)[1]["blockers"])

    def test_detects_missing_alarms_disabled_actions_metric_drift_and_pending_subscription(self):
        data = Responses()
        data.records["get-topic-attributes"] = "0"
        data.records["list-alarm-mute-rules"] = 1
        data.records["get-schedule"]["enabled"] = "DISABLED"
        alarms = data.records["describe-alarms"]
        alarms[:] = [r for r in alarms if r["name"] != "random-resource-CardWorkerAlarm"]
        by_name = {item["name"].removeprefix("random-resource-"): item for item in alarms}
        by_name["ReviewAlarm"]["state"] = "ALARM"
        by_name["MonitorErrorAlarm"]["actions"] = ["different-topic"]
        by_name["LedgerAlarm"]["recovery"] = []
        by_name["MissingMonitorAlarm"]["missing"] = "notBreaching"
        by_name["BlockedCardAlarm"]["enabled"] = False
        by_name["QueueFailureAlarm"]["Metrics"][1]["MetricStat"]["Metric"]["Dimensions"] = []
        self.assertEqual({"CardWorkerAlarm.missing", "MonitorErrorAlarm.notification_route", "ReviewAlarm.state",
                          "LedgerAlarm.notification_route", "BlockedCardAlarm.notification_route",
                          "QueueFailureAlarm.metric", "MissingMonitorAlarm.muted", "MissingMonitorAlarm.detection", "no_confirmed_subscription", "schedule_configuration"},
                         set(preflight.run(args(), data, NOW)[1]["blockers"]))
        data.records["list-stack-resources"].pop()
        self.assertIn("stack_alarm_set_mismatch", preflight.run(args(), data, NOW)[1]["blockers"])

    def test_partial_or_unavailable_response_is_sanitized_and_never_passes(self):
        for malformed in [None, [{}, {}], [{"id": None}], [{"id": "wrong"}]]:
            data = Responses()
            data.records["describe-stacks"] = deepcopy(malformed)
            self.assertNotEqual(0, preflight.run(args(), data, NOW)[0])
        with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(
                1, "private credential", stderr=b"sensitive-text")) as run:
            code, report = preflight.run(args(), now=NOW)
            self.assertEqual((2, "sts.get-caller-identity"), (code, report["error"]))
            self.assertNotIn("sensitive-text", json.dumps(report))
            self.assertEqual(30, run.call_args.kwargs["timeout"])
            arguments = run.call_args.args[0]
            self.assertEqual(REGION, arguments[arguments.index("--region") + 1])
        with patch.object(subprocess, "run", side_effect=FileNotFoundError()):
            self.assertEqual("aws_cli_unavailable", preflight.run(args(), now=NOW)[1]["error"])


if __name__ == "__main__":
    unittest.main()
