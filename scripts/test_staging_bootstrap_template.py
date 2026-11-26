from pathlib import Path
import unittest

from cfnlint.decode import decode


class StagingBootstrapTaskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "infra" / "staging-bootstrap.yaml"
        cls.template, errors = decode(str(path))
        if errors:
            raise ValueError(errors)
        cls.resources = cls.template["Resources"]
        cls.task = cls.resources["BootstrapTask"]["Properties"]

    def test_stack_registers_only_a_manually_started_digest_pinned_task(self):
        self.assertCountEqual([resource["Type"] for resource in self.resources.values()], [
            "AWS::Logs::LogGroup", "AWS::IAM::Role", "AWS::ECS::TaskDefinition",
        ])
        self.assertEqual(self.task["NetworkMode"], "awsvpc")
        self.assertEqual(self.task["RequiresCompatibilities"], ["FARGATE"])
        self.assertEqual(self.task["RuntimePlatform"], {"CpuArchitecture": "X86_64", "OperatingSystemFamily": "LINUX"})
        self.assertNotIn("TaskRoleArn", self.task)
        self.assertEqual(self.task["ExecutionRoleArn"], {"Fn::GetAtt": ["BootstrapExecutionRole", "Arn"]})
        (container,) = self.task["ContainerDefinitions"]
        self.assertEqual(container["Command"], ["node", "dist-server/staging-bootstrap.js"])
        self.assertEqual(container["Image"]["Fn::Sub"],
                         "${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/${EcrRepositoryName}@${ImageDigest}")
        self.assertTrue(container["ReadonlyRootFilesystem"])
        self.assertEqual(container["User"], "node")

    def test_secrets_are_injected_only_into_the_bootstrap_container(self):
        (container,) = self.task["ContainerDefinitions"]
        self.assertEqual({entry["Name"]: entry["ValueFrom"] for entry in container["Secrets"]}, {
            "AQUA_STAGING_DB_ADMIN_JSON": {"Ref": "AdminSecretArn"},
            "MONITOR_DATABASE_SECRET": {"Ref": "MonitorDatabaseSecretArn"},
        })
        self.assertEqual({entry["Name"]: entry["Value"] for entry in container["Environment"]}, {
            "NODE_ENV": "production", "DATABASE_HOST": {"Ref": "DatabaseHost"},
            "DATABASE_NAME": "aqua", "DATABASE_SCHEMA": "aqua", "DATABASE_CA_FILE": "/etc/aqua/rds-ca.pem",
        })
        self.assertEqual(container["LogConfiguration"]["Options"]["awslogs-group"], {"Ref": "BootstrapLogs"})
        self.assertEqual(self.template["Outputs"]["BootstrapTaskDefinitionArn"]["Value"], {"Ref": "BootstrapTask"})

    def test_execution_role_can_only_start_the_container_and_retrieve_its_two_secrets(self):
        role = self.resources["BootstrapExecutionRole"]["Properties"]
        self.assertNotIn("ManagedPolicyArns", role)
        (trust,) = role["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(trust["Principal"], {"Service": "ecs-tasks.amazonaws.com"})
        self.assertEqual(trust["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
        (policy,) = role["Policies"]
        actions = {}
        for grant in policy["PolicyDocument"]["Statement"]:
            self.assertEqual(grant["Effect"], "Allow")
            names = grant["Action"] if isinstance(grant["Action"], list) else [grant["Action"]]
            for name in names:
                self.assertNotIn(name, actions)
                actions[name] = grant["Resource"]
        ecr = {"Fn::Sub": "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/${EcrRepositoryName}"}
        logs = {"Fn::GetAtt": ["BootstrapLogs", "Arn"]}
        self.assertEqual(actions, {
            "ecr:GetAuthorizationToken": "*", "ecr:BatchGetImage": ecr, "ecr:GetDownloadUrlForLayer": ecr,
            "ecr:BatchCheckLayerAvailability": ecr, "logs:CreateLogStream": logs, "logs:PutLogEvents": logs,
            "secretsmanager:GetSecretValue": [{"Ref": "AdminSecretArn"}, {"Ref": "MonitorDatabaseSecretArn"}],
        })


if __name__ == "__main__":
    unittest.main()
