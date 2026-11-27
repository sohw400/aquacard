from pathlib import Path
import unittest

from cfnlint.decode import decode


def template(name):
    root = Path(__file__).resolve().parents[1]
    doc, errors = decode(str(root / "infra" / name))
    if errors:
        raise ValueError(errors)
    return doc


class StagingRuntimeTest(unittest.TestCase):
    def test_only_an_approved_private_https_client_can_reach_the_edge(self):
        resources = template("staging-runtime-edge.yaml")["Resources"]
        self.assertEqual(resources["Edge"]["Properties"]["Scheme"], "internal")
        rule, = resources["EdgeGroup"]["Properties"]["SecurityGroupIngress"]
        self.assertEqual((rule["FromPort"], rule["ToPort"], rule["SourceSecurityGroupId"]), (443, 443, {"Ref": "ClientSecurityGroupId"}))
        self.assertEqual(resources["TlsListener"]["Properties"]["Protocol"], "HTTPS")
        self.assertEqual(resources["WebhookRoute"]["Properties"]["Conditions"], [
            {"Field": "path-pattern", "Values": ["/webhooks/sandbox/cards"]},
            {"Field": "http-request-method", "HttpRequestMethodConfig": {"Values": ["POST"]}},
        ])
        for name, path in [("ApiTargets", "/api/health"), ("IngressTargets", "/health")]:
            group = resources[name]["Properties"]
            self.assertEqual((group["HealthCheckPath"], group["TargetType"]), (path, "ip"))

    def test_each_role_has_one_db_login_a_digest_and_no_aws_application_permissions(self):
        doc = template("staging-runtime-service.yaml")
        entries = doc["Mappings"]["Service"]
        self.assertEqual(len(entries), 5)
        self.assertEqual(len({row["Database"] for row in entries.values()}), len(entries))
        resources = doc["Resources"]
        task = resources["Task"]["Properties"]
        self.assertNotIn("TaskRoleArn", task)
        self.assertEqual(task["ExecutionRoleArn"], {"Fn::GetAtt": ["ExecutionRole", "Arn"]})
        runtime, conditional = task["ContainerDefinitions"]
        _, sidecar, _ = conditional["Fn::If"]
        self.assertEqual(runtime["Image"], sidecar["Image"])
        self.assertIn("@${ImageDigest}", runtime["Image"]["Fn::Sub"])
        self.assertEqual(sidecar["Command"], ["node", "dist-server/staging-issuer.js"])
        self.assertNotIn("PortMappings", sidecar)
        self.assertEqual({secret["Name"] for secret in sidecar["Secrets"]}, {"AQUA_ISSUER_KEY_ID", "AQUA_ISSUER_SIGNING_KEY"})
        statements = resources["ExecutionRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertEqual([s["Action"] for s in statements if s["Resource"] == "*"], ["ecr:GetAuthorizationToken"])
        secret_grant, = (s for s in statements if s["Action"] == "secretsmanager:GetSecretValue")
        self.assertEqual(secret_grant["Resource"], {"Ref": "RuntimeSecretArn"})

    def test_starts_at_zero_with_no_public_network(self):
        doc = template("staging-runtime-service.yaml")
        self.assertEqual(doc["Parameters"]["DesiredCount"]["Default"], 0)
        resources = doc["Resources"]
        service = resources["Service"]["Properties"]
        network = service["NetworkConfiguration"]["AwsvpcConfiguration"]
        self.assertEqual(network["AssignPublicIp"], "DISABLED")
        self.assertFalse(service["EnableExecuteCommand"])
        self.assertEqual(service["DeploymentConfiguration"]["DeploymentCircuitBreaker"], {"Enable": True, "Rollback": True})
        task_egress = resources["TaskGroup"]["Properties"]["SecurityGroupEgress"]
        self.assertCountEqual([rule["ToPort"] for rule in task_egress], [443, 443, 5432])
        self.assertTrue(all("CidrIp" not in rule for rule in task_egress))
        for rule in ["EdgeToTask", "TaskFromEdge"]:
            self.assertEqual(resources[rule]["Condition"], "Http")
        self.assertIn("EndpointSecurityGroupId", template("staging-network.yaml")["Outputs"])
