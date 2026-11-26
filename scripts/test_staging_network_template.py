from pathlib import Path
import unittest

from cfnlint.decode import decode


def group_id(resource):
    return {"Fn::GetAtt": [resource, "GroupId"]}


class PrivateStagingNetworkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "infra" / "staging-network.yaml"
        cls.template, errors = decode(str(path))
        if errors:
            raise ValueError(errors)
        cls.resources = cls.template["Resources"]

    def test_private_subnets_in_two_zones_only_route_to_vpc_and_s3(self):
        by_type = {r["Type"] for r in self.resources.values()}
        self.assertFalse(by_type.intersection({"AWS::EC2::InternetGateway", "AWS::EC2::NatGateway",
                                               "AWS::EC2::EgressOnlyInternetGateway", "AWS::EC2::Route"}))
        vpc = self.resources["Vpc"]["Properties"]
        self.assertIs(vpc["EnableDnsSupport"], True)
        self.assertIs(vpc["EnableDnsHostnames"], True)
        subnet_names = set()
        for suffix, az in [("A", "PrimaryAvailabilityZone"), ("B", "SecondaryAvailabilityZone")]:
            subnet_name = "PrivateSubnet" + suffix
            subnet_names.add(subnet_name)
            subnet = self.resources[subnet_name]["Properties"]
            self.assertEqual(subnet["AvailabilityZone"], {"Ref": az})
            self.assertIs(subnet["MapPublicIpOnLaunch"], False)
            self.assertEqual(self.resources["Subnet" + suffix + "Routes"]["Properties"], {
                "SubnetId": {"Ref": subnet_name}, "RouteTableId": {"Ref": "PrivateRoutes"},
            })
        self.assertEqual(subnet_names, {name for name, r in self.resources.items() if r["Type"] == "AWS::EC2::Subnet"})
        zones = [self.template["Parameters"][n]["Default"] for n in ("PrimaryAvailabilityZone", "SecondaryAvailabilityZone")]
        self.assertNotEqual(*zones)
        zone_constraint = self.template["Rules"]["DistinctAvailabilityZones"]["Assertions"][0]["Assert"]
        self.assertEqual(zone_constraint, {"Fn::Not": [{"Fn::Equals": [
            {"Ref": "PrimaryAvailabilityZone"}, {"Ref": "SecondaryAvailabilityZone"},
        ]}]})

    def test_private_endpoints_cover_image_pull_secrets_and_logs(self):
        interfaces = []
        for resource in self.resources.values():
            if resource["Type"] != "AWS::EC2::VPCEndpoint":
                continue
            props = resource["Properties"]
            if props["VpcEndpointType"] == "Interface":
                self.assertIs(props["PrivateDnsEnabled"], True)
                self.assertEqual(props["SecurityGroupIds"], [group_id("EndpointSecurityGroup")])
                self.assertEqual(props["SubnetIds"], [{"Ref": "PrivateSubnetA"}])
                interfaces.append(props["ServiceName"]["Fn::Sub"])
        self.assertCountEqual(interfaces, [
            "com.amazonaws.${AWS::Region}." + service for service in ("ecr.api", "ecr.dkr", "logs", "secretsmanager")
        ])
        gateway = self.resources["S3Gateway"]["Properties"]
        self.assertEqual(gateway["VpcEndpointType"], "Gateway")
        self.assertEqual(gateway["ServiceName"], {"Fn::Sub": "com.amazonaws.${AWS::Region}.s3"})
        self.assertEqual(gateway["RouteTableIds"], [{"Ref": "PrivateRoutes"}])
        self.assertEqual(gateway["PolicyDocument"]["Statement"], [{
            "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",
            "Resource": {"Fn::Sub": "arn:${AWS::Partition}:s3:::prod-${AWS::Region}-starport-layer-bucket/*"},
        }])

    def test_task_groups_reach_their_intended_endpoints_and_databases_only(self):
        source = "SourceDatabaseSecurityGroup"
        endpoint = "EndpointSecurityGroup"
        groups = {name: r["Properties"] for name, r in self.resources.items() if r["Type"] == "AWS::EC2::SecurityGroup"}
        callers = ("MonitorSecurityGroup", "BootstrapSecurityGroup", "VerifierSecurityGroup")
        self.assertEqual(set(groups), {source, endpoint, *callers})
        inbound = []
        for props in groups.values():
            self.assertFalse(props.get("SecurityGroupIngress"))
        for receiver in (source, endpoint):
            self.assertEqual(groups[receiver]["SecurityGroupEgress"], [{"IpProtocol": "-1", "CidrIp": "127.0.0.1/32"}])
        for caller in callers:
            expected = [
                {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "DestinationSecurityGroupId": group_id(endpoint)},
                {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "DestinationPrefixListId": {"Ref": "S3PrefixListId"}},
            ]
            inbound.append({"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
                            "SourceSecurityGroupId": group_id(caller), "GroupId": group_id(endpoint)})
            if caller != "VerifierSecurityGroup":
                expected.append({"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "DestinationSecurityGroupId": group_id(source)})
                inbound.append({"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
                                "SourceSecurityGroupId": group_id(caller), "GroupId": group_id(source)})
            self.assertCountEqual(groups[caller]["SecurityGroupEgress"], expected)
        self.assertCountEqual(inbound, [r["Properties"] for r in self.resources.values() if r["Type"] == "AWS::EC2::SecurityGroupIngress"])
        self.assertFalse(any(r["Type"] == "AWS::EC2::SecurityGroupEgress" for r in self.resources.values()))


if __name__ == "__main__":
    unittest.main()
