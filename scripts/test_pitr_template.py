import ipaddress
from pathlib import Path
import unittest

from cfnlint.decode import decode


class StagingRestoreTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "infra" / "staging-pitr.yaml"
        cls.template, errors = decode(str(path))
        if errors:
            raise ValueError(errors)
        cls.group = cls.template["Resources"]["RestoreSecurityGroup"]["Properties"]
        cls.database = cls.template["Resources"]["RestoredDB"]

    def test_creates_one_fresh_db_at_the_requested_point(self):
        resources = self.template["Resources"]
        self.assertCountEqual(
            (value["Type"] for value in resources.values()),
            ["AWS::RDS::DBInstance", "AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupEgress"],
        )
        db = self.database["Properties"]
        self.assertEqual(db["SourceDbiResourceId"], {"Ref": "SourceDbiResourceId"})
        self.assertEqual(db["RestoreTime"], {"Ref": "RestoreTime"})
        for key in ("DBInstanceIdentifier", "DBSnapshotIdentifier", "UseLatestRestorableTime",
                    "StorageEncrypted", "KmsKeyId"):
            self.assertNotIn(key, db)
        self.assertIs(db["PubliclyAccessible"], False)
        self.assertEqual(db["DBSubnetGroupName"], {"Ref": "PrivateDBSubnetGroupName"})
        self.assertEqual(db["VPCSecurityGroups"], [{"Fn::GetAtt": ["RestoreSecurityGroup", "GroupId"]}])

    def test_only_verifier_can_open_a_postgresql_connection(self):
        group = self.group
        self.assertEqual(group["VpcId"], {"Ref": "VpcId"})
        port = int(self.database["Properties"]["Port"])
        self.assertEqual(group["SecurityGroupIngress"], [{
            "IpProtocol": "tcp", "FromPort": port, "ToPort": port,
            "SourceSecurityGroupId": {"Ref": "VerifierSecurityGroupId"},
        }])
        # EC2 restores the default allow-all when no explicit egress is configured.
        self.assertTrue(group["SecurityGroupEgress"])
        for rule in group["SecurityGroupEgress"]:
            self.assertTrue(ipaddress.ip_network(rule["CidrIp"]).is_loopback)
            self.assertFalse({"CidrIpv6", "DestinationSecurityGroupId", "DestinationPrefixListId"} & rule.keys())

    def test_opt_in_egress_connects_verifier_only_to_the_drill_database(self):
        self.assertEqual(self.template["Parameters"]["ManageVerifierEgress"]["Default"], "false")
        rule = self.template["Resources"]["VerifierToRestore"]
        self.assertEqual(self.template["Conditions"][rule["Condition"]], {
            "Fn::Equals": [{"Ref": "ManageVerifierEgress"}, "true"],
        })
        self.assertEqual(rule["Properties"], {
            "GroupId": {"Ref": "VerifierSecurityGroupId"},
            "IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
            "DestinationSecurityGroupId": {"Fn::GetAtt": ["RestoreSecurityGroup", "GroupId"]},
        })

    def test_stack_deletion_cleans_up_the_disposable_copy(self):
        self.assertEqual(self.database["DeletionPolicy"], "Delete")
        self.assertEqual(self.database["UpdateReplacePolicy"], "Delete")
        db = self.database["Properties"]
        self.assertIs(db["DeletionProtection"], False)
        self.assertEqual(db["BackupRetentionPeriod"], 0)
        self.assertIs(db["DeleteAutomatedBackups"], True)


if __name__ == "__main__":
    unittest.main()
