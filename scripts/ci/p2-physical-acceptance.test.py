"""Prospective source guards, NOT RUN. All boundaries are recorded fakes.

No Docker process, registry, port, config contents or credential access is used.
Synthetic report/inspection values below are unit fixtures, never runtime proof.
"""
import copy
import hashlib
import json
import runpy
import unittest
from pathlib import Path

H = runpy.run_path(str(Path(__file__).with_name("p2-physical-acceptance.py")))
M = json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
ID = "a" * 64
IMAGE = "sha256:" + "b" * 64
JOB = {"repository": "fixture/deploylite", "runId": "123", "runAttempt": "1", "job": "p2-docker-acceptance"}

class FakeBoundary:
    def __init__(self):
        self.calls = []
        self.now = 0.0
        self.elapsed = 0.0
    def run(self, argv, **options):
        self.calls.append((argv, options))
        self.now += self.elapsed
        return {"returncode": 0, "stdout": "recorded-only", "stderr": ""}

class ProspectivePhysicalGuards(unittest.TestCase):
    def setUp(self):
        self.env = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": JOB["repository"],
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": JOB["job"], "GITHUB_SHA": "c" * 40,
                    "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": "/tmp/fresh-private-empty-config",
                    "DEPLOYLITE_DOCKER_RUNTIME_GRANT": "P2_PHYSICAL_DOCKER_APPROVED"}
        self.grant = {"authorization": "P2_PHYSICAL_DOCKER_APPROVED", "grantId": "fixture-grant-123456789", "runId": "11111111-1111-4111-8111-111111111111",
                      "engineScope": "ephemeral-github-actions-job", "ciJob": JOB.copy(), "commit": "c" * 40,
                      "expiresAtMs": 60000, "dockerHost": self.env["DOCKER_HOST"], "dockerConfigDirectory": self.env["DOCKER_CONFIG"],
                      "engineId": "explicit-recorded-engine-123", "platform": "linux/amd64", "engineOs": "linux", "engineArchitecture": "x86_64",
                      "owner": "p2v-fixture", "projectId": "22222222-2222-4222-8222-222222222222",
                      "bounds": M["resourceProposal"].copy(), "expiryClosures": {"cleanupMaxMs": 30000},
                      "sourceHashes": {p: "d" * 64 for p in M["sourceFiles"]}}
        self.fake = FakeBoundary()
    def rejected_context(self, grant=None, env=None):
        with self.assertRaises(H["PhysicalError"]): H["validate_context"](grant or self.grant, self.env if env is None else env, 0)
        self.assertEqual(self.fake.calls, [])
    def test_missing_explicit_runtime_grant_is_rejected(self):
        self.rejected_context(env={k:v for k,v in self.env.items() if k != "DEPLOYLITE_DOCKER_RUNTIME_GRANT"})
    def test_nonhosted_and_missing_hosted_identity_are_rejected(self):
        for value in (None, "self-hosted"):
            with self.subTest(runner=value): self.rejected_context(env={**self.env, "RUNNER_ENVIRONMENT": value})
    def test_wrong_job_run_attempt_repository_or_commit_are_rejected(self):
        for field in ("GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY", "GITHUB_SHA"):
            with self.subTest(field=field): self.rejected_context(env={**self.env, field: "foreign"})
    def test_expired_grant_cannot_prepare_a_new_fixture(self):
        self.rejected_context(grant={**self.grant, "expiresAtMs": -1})
    def test_ambient_context_or_tls_cannot_enter_the_command_boundary(self):
        for field in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            with self.subTest(field=field): self.rejected_context(env={**self.env, field: "ambient"})
    def test_native_engine_platform_id_and_socket_are_bound(self):
        for field,value in [("engineId", ""), ("platform", "linux/arm64"), ("engineOs", "windows"), ("dockerHost", "tcp://foreign:2375")]:
            with self.subTest(field=field): self.rejected_context(grant={**self.grant, field:value})
    def test_protected_ports_and_widened_owned_caps_are_rejected(self):
        for field,value in [("registryPort", 3000),("physicalPorts",[31849,31859]),("registryCpu",2),("registryMemoryBytes",0),
                            ("fixtureCpu",2),("fixtureMemoryBytes",0),("physicalMaxContainers",4),("prepMaxContainers",3),("cleanupMaxSeconds",31)]:
            with self.subTest(field=field): self.rejected_context(grant={**self.grant,"bounds":{**self.grant["bounds"],field:value}})
    def test_private_config_type_symlink_owner_mode_and_emptiness_are_checked(self):
        valid={"directory":True,"symlink":False,"owned":True,"mode":0o700}
        for change,entries in [({"directory":False},[]),({"symlink":True},[]),({"owned":False},[]),({"mode":0o755},[]),({},["config.json"])]:
            with self.subTest(change=change,entries=entries):
                with self.assertRaises(H["PhysicalError"]): H["validate_config"]({**valid,**change},entries)
    def test_missing_changed_or_extra_current_source_hashes_fail_closed(self):
        expected=self.grant["sourceHashes"]
        for current in [{}, {**expected,next(iter(expected)):"e"*64}, {**expected,"foreign.ts":"d"*64}]:
            with self.subTest(current=current): self.assertFalse(H["validate_sources"](expected,current))
    def test_observed_manifest_hash_must_match_header_not_image_id(self):
        body=b'{"schemaVersion":2,"config":{"digest":"sha256:' + b'b'*64 + b'"}}'
        repository="127.0.0.1:49172/deploylite-p2/fixture"
        for digest in (IMAGE,"sha256:"+"e"*64,"latest"):
            with self.subTest(digest=digest):
                with self.assertRaises(H["PhysicalError"]): H["manifest_reference"](body,digest,repository)
    def image(self):
        return {"id":IMAGE,"repoDigests":["127.0.0.1:49172/deploylite-p2/fixture@sha256:"+"e"*64],"platform":"linux/amd64",
                "user":"65532:65532","command":["/bin/busybox","httpd","-f","-p","8080","-h","/www"],"healthIntervalNs":1000000000,
                "healthTimeoutNs":1000000000,"healthPath":"/healthz","flavor":"a"}
    def test_image_id_only_wrong_repo_digest_user_platform_or_health_are_rejected(self):
        expected={"reference":self.image()["repoDigests"][0],"platform":"linux/amd64","flavor":"a"}
        for field,value in [("repoDigests",[]),("platform","linux/arm64"),("user","0:0"),("command",["sh"]),("healthIntervalNs",0),("healthPath","http://foreign")]:
            with self.subTest(field=field):
                with self.assertRaises(H["PhysicalError"]): H["validate_image"]({**self.image(),field:value},expected)
    def resource(self):
        return {"id":ID,"kind":"registry","owner":self.grant["owner"],"projectId":self.grant["projectId"],"imageId":IMAGE,
                "imageRef":M["fixture"]["registry"],"cpuNano":500000000,"memoryBytes":268435456,"pids":64,
                "networkId":"f"*64,"hostIp":"127.0.0.1","hostPort":49172,"readonly":True,"privileged":False,"binds":[],"labelsVerified":True}
    def test_exact_owned_ids_labels_images_network_and_limits_are_checked_before_removal(self):
        owned=self.resource()
        for field,value in [("id","e"*64),("owner","foreign"),("projectId","foreign"),("imageId","sha256:"+"e"*64),("networkId","e"*64),
                            ("cpuNano",0),("memoryBytes",0),("pids",0),("hostIp","0.0.0.0"),("hostPort",3000),("privileged",True),("binds",["/private"])]:
            with self.subTest(field=field):
                with self.assertRaises(H["PhysicalError"]): H["validate_owned_resource"]({**owned,field:value},owned,self.grant["bounds"])
    def test_preparation_plan_uses_pins_serial_a_h_builds_and_derived_exact_digest_pulls(self):
        plan=H["preparation_plan"](self.grant,M)
        builds=[step for step in plan if step["kind"]=="build"]
        self.assertEqual([step["target"] for step in builds],["a","h"])
        self.assertTrue(all("--network=none" in step["argv"] and "--pull=false" in step["argv"] for step in builds))
        self.assertTrue(all(step["context"]==M["fixture"]["context"] for step in builds))
        self.assertEqual([step["image"] for step in plan if step["kind"]=="input-pull"],[M["fixture"]["base"],M["fixture"]["registry"]])
        self.assertTrue(any(step["kind"]=="registry-removed-before-cases" for step in plan))
    def test_every_command_has_explicit_config_host_no_shell_and_effect_deadline(self):
        argv=["docker","info"]
        H["run_effect"](argv,self.grant,self.fake)
        actual,options=self.fake.calls[0]
        self.assertEqual(actual[:5],["docker","--config",self.env["DOCKER_CONFIG"],"--host",self.env["DOCKER_HOST"]])
        self.assertNotIn("shell",options);self.assertLessEqual(options["timeout"],120)
    def test_fresh_effect_after_expiry_and_postexpiry_recovery_without_final_binding_are_rejected(self):
        self.fake.now=61
        for closure in (None,{"kind":"recovery","deadline":121}):
            with self.subTest(closure=closure):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","start",ID],self.grant,self.fake,closure)
        self.assertEqual(self.fake.calls,[])
    def test_postexpiry_cleanup_requires_explicit_nonrenewing_deadline_and_exact_recorded_ids(self):
        self.fake.now=61
        for closure in (None,{"kind":"cleanup","deadline":60},{"kind":"cleanup","deadline":92},{"kind":"cleanup","deadline":62,"ownedIds":[]}):
            with self.subTest(closure=closure):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","rm","--force",ID],self.grant,self.fake,closure)
    def test_process_timeout_does_not_create_verified_preparation_or_renew_total_budget(self):
        self.fake.elapsed=121
        with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","build","fixture"],self.grant,self.fake)
    def test_global_daemon_mutation_prune_foreign_network_and_tagged_inputs_are_never_planned(self):
        for argv in (["docker","system","prune"],["docker","update","--memory","1g",ID],["docker","network","rm","foreign"],
                     ["docker","pull","busybox:latest"],["docker","build","--network=host","."]):
            with self.subTest(argv=argv):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](argv,self.grant,self.fake)
        self.assertEqual(self.fake.calls,[])
    def test_characterizes_valid_declared_job_without_implicit_runtime_effects(self):
        self.assertEqual(H["validate_context"](self.grant,self.env,0),self.grant);self.assertEqual(self.fake.calls,[])
    def test_characterizes_private_empty_config_metadata_without_contents(self):
        self.assertIsNone(H["validate_config"]({"directory":True,"symlink":False,"owned":True,"mode":0o700},[]))
    def test_characterizes_reference_from_matching_observed_manifest_bytes_and_header(self):
        body=b'{"schemaVersion":2}';digest="sha256:"+hashlib.sha256(body).hexdigest();repository="127.0.0.1:49172/deploylite-p2/fixture"
        self.assertEqual(H["manifest_reference"](body,digest,repository),repository+"@"+digest)
    def test_characterizes_valid_owned_image_and_resource_observations_as_unit_inputs(self):
        expected={"reference":self.image()["repoDigests"][0],"platform":"linux/amd64","flavor":"a"}
        self.assertEqual(H["validate_image"](self.image(),expected),self.image())
        self.assertEqual(H["validate_owned_resource"](self.resource(),self.resource(),self.grant["bounds"]),self.resource())
    def test_neutral_recorded_boundaries_do_not_construct_a_native_process(self):
        with self.assertRaises(H["PhysicalError"]):
            H["run_effect"](["docker","info"],self.grant,None)
        self.assertEqual(self.fake.calls,[])

if __name__ == "__main__":
    unittest.main(verbosity=2)
