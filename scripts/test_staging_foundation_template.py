import json
from pathlib import Path
import unittest

from cfnlint.decode import decode


class StagingFoundationTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "infra" / "staging-foundation.yaml"
        cls.template, errors = decode(str(path))
        if errors:
            raise ValueError(errors)
        cls.resources = cls.template["Resources"]
        cls.outputs = {key: output["Value"] for key, output in cls.template["Outputs"].items()}

    def test_private_encrypted_source_can_supply_point_in_time_recovery(self):
        resource = self.resources["Database"]
        db = resource["Properties"]
        self.assertEqual(db["Engine"], "postgres")
        self.assertEqual(db["EngineVersion"], {"Ref": "EngineVersion"})
        self.assertEqual(db["StorageType"], "gp3")
        self.assertIs(db["StorageEncrypted"], True)
        self.assertIs(db["PubliclyAccessible"], False)
        self.assertEqual(db["VPCSecurityGroups"], [{"Ref": "SourceDatabaseSecurityGroupId"}])
        subnet_group = self.resources[db["DBSubnetGroupName"]["Ref"]]["Properties"]
        self.assertEqual(subnet_group["SubnetIds"], {"Ref": "PrivateSubnetIds"})
        parameters = self.resources[db["DBParameterGroupName"]["Ref"]]["Properties"]
        self.assertEqual(parameters["Family"], "postgres18")
        self.assertEqual(parameters["Parameters"]["rds.force_ssl"], "1")
        self.assertGreaterEqual(db["BackupRetentionPeriod"], 7)
        self.assertIs(db["DeleteAutomatedBackups"], False)
        self.assertEqual(resource["DeletionPolicy"], "Snapshot")
        self.assertEqual(resource["UpdateReplacePolicy"], "Snapshot")

    def test_separate_generated_logins_bind_to_the_same_source(self):
        db = self.resources["Database"]["Properties"]
        self.assertIs(db["ManageMasterUserPassword"], True)
        self.assertNotIn("MasterUserPassword", db)
        self.assertEqual(self.outputs["DBMasterSecretArn"],
                         {"Fn::GetAtt": ["Database", "MasterUserSecret.SecretArn"]})
        secret = self.resources[self.outputs["MonitorDatabaseSecretArn"]["Ref"]]
        self.assertEqual(secret["Type"], "AWS::SecretsManager::Secret")
        generated = secret["Properties"]["GenerateSecretString"]
        connection = json.loads(generated["SecretStringTemplate"]["Fn::Sub"])
        self.assertEqual(connection, {
            "host": "${Database.Endpoint.Address}", "port": int(db["Port"]),
            "dbname": db["DBName"], "username": "aqua_monitor",
        })
        self.assertNotEqual(connection["username"], db["MasterUsername"])
        self.assertEqual(generated["GenerateStringKey"], "password")
        self.assertGreaterEqual(generated["PasswordLength"], 32)
        self.assertNotIn("SecretString", secret["Properties"])

    def test_private_images_fargate_and_scoped_alarm_route(self):
        repo = self.resources[self.outputs["EcrRepositoryName"]["Ref"]]
        self.assertEqual(repo["Type"], "AWS::ECR::Repository")
        self.assertEqual(repo["Properties"]["ImageTagMutability"], "IMMUTABLE")
        self.assertIs(repo["Properties"]["ImageScanningConfiguration"]["ScanOnPush"], True)
        self.assertEqual(repo["DeletionPolicy"], "Retain")
        cluster, attribute = self.outputs["ClusterArn"]["Fn::GetAtt"]
        self.assertEqual(attribute, "Arn")
        self.assertIn("FARGATE", self.resources[cluster]["Properties"]["CapacityProviders"])
        topic = self.outputs["AlarmTopicArn"]
        self.assertNotIn("Subscription", self.resources[topic["Ref"]]["Properties"])
        self.assertFalse(any(resource["Type"] == "AWS::SNS::Subscription" for resource in self.resources.values()))
        policy = self.resources["AlarmTopicPolicy"]["Properties"]
        self.assertEqual(policy["Topics"], [topic])
        grants = [s for s in policy["PolicyDocument"]["Statement"] if s["Effect"] == "Allow"]
        self.assertEqual(len(grants), 1)
        grant = grants[0]
        self.assertEqual(grant["Principal"], {"Service": "cloudwatch.amazonaws.com"})
        self.assertEqual(grant["Action"], "sns:Publish")
        self.assertEqual(grant["Resource"], topic)
        self.assertEqual(grant["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
        self.assertEqual(grant["Condition"]["ArnLike"]["aws:SourceArn"],
                         {"Fn::Sub": "arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*"})


if __name__ == "__main__":
    unittest.main()
