import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import hashlib
import json
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("p5_native", Path(__file__).with_name("p5-native-acceptance.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class NativeContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "deploylite-p5-native-empty-docker-config"
        self.config.mkdir(mode=0o700)
        self.env = {"DEPLOYLITE_P5_NATIVE_RUNTIME_GRANT": "P5_NATIVE_CI_APPROVED", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
            "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite", "GITHUB_JOB": "p5-native-database-acceptance", "DEPLOYLITE_P5_HEAD_REPOSITORY": "DeployLiteApp/DeployLite",
            "GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "feat/p5-database-runtime-composition", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "DEPLOYLITE_P5_EXPECTED_SHA": "a" * 40, "DOCKER_HOST": "unix:///var/run/docker.sock", "RUNNER_TEMP": str(self.root), "DOCKER_CONFIG": str(self.config)}
        self.git = patch.object(module, "checkout_sha", return_value="a" * 40, create=True)
        self.git.start()
    def tearDown(self):
        self.git.stop()
        self.temp.cleanup()
    def test_exact_hosted_five_engine_scope(self):
        result = module.native_context(self.env, self.root)
        self.assertEqual(result["commit"], "a" * 40)
        self.assertEqual(result["job"], "p5-native-database-acceptance")
        self.assertEqual(result["runId"], "123")
    def test_denies_missing_grant_foreign_fork_job_runner_and_event(self):
        for key, value in {"DEPLOYLITE_P5_NATIVE_RUNTIME_GRANT":"", "DEPLOYLITE_P5_HEAD_REPOSITORY":"foreign/repo", "GITHUB_REPOSITORY":"foreign/repo",
            "GITHUB_JOB":"p3-docker-acceptance", "RUNNER_ENVIRONMENT":"self-hosted", "GITHUB_ACTIONS":"false", "GITHUB_EVENT_NAME":"workflow_dispatch"}.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.native_context({**self.env, key:value}, self.root)
    def test_denies_protected_database_and_external_socket_context(self):
        for key, value in {"DATABASE_URL":"postgres://protected", "DOCKER_HOST":"ssh://host", "DOCKER_CONTEXT":"shared", "DOCKER_TLS_VERIFY":"1", "DOCKER_CERT_PATH":"private"}.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.native_context({**self.env, key:value}, self.root)
    def test_denies_mismatched_source_and_ambient_config(self):
        with self.assertRaises(RuntimeError): module.native_context({**self.env,"DEPLOYLITE_P5_EXPECTED_SHA":"b"*40}, self.root)
        with self.assertRaises(RuntimeError): module.native_context({**self.env,"DOCKER_CONFIG":str(self.root)}, self.root)
        (self.config/"config.json").write_text("{}")
        with self.assertRaises(RuntimeError): module.native_context(self.env,self.root)
    def test_denies_insecure_private_config_or_missing_run_identity(self):
        os.chmod(self.config,0o755)
        with self.assertRaises(RuntimeError): module.native_context(self.env,self.root)
        os.chmod(self.config,0o700)
        for key in ["GITHUB_RUN_ID","GITHUB_RUN_ATTEMPT"]:
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.native_context({**self.env,key:""},self.root)
    def test_official_fixture_profiles_are_complete_pinned_and_test_only(self):
        import json
        manifest = json.loads(Path(__file__).with_name("p5-native-profiles.json").read_text())
        self.assertEqual(set(module.validate_profiles(manifest)), set(module.ENGINES))
        invalid = json.loads(json.dumps(manifest))
        invalid["profiles"]["mysql"]["image"] = "docker.io/library/mysql:latest"
        for value in [{**manifest,"fixtureOnly":False}, {**manifest,"profiles":{}}, invalid]:
            with self.assertRaises(RuntimeError): module.validate_profiles(value)


class ReportAdmission(unittest.TestCase):
    def test_native_report_requires_all_five_executed_cases(self):
        report = {"numTotalTests":5,"numPassedTests":5,"numFailedTests":0,"numPendingTests":0,"success":True,"testResults":[{"assertionResults":[{"fullName":"native five-engine physical " + engine + " startup and persistence","status":"passed"} for engine in module.ENGINES]}]}
        module.validate_report(report)
        for mutation in ({"numPendingTests":1},{"numPassedTests":4},{"numFailedTests":1},{"success":False},{"testResults":[]}):
            with self.assertRaises(RuntimeError):
                module.validate_report({**report,**mutation})

class NativeResourceReceipt(unittest.TestCase):
    def test_requires_original_resource_identities_in_the_persisted_receipt(self):
        result = {"receipt":{"networkId":"f"*64,"volumeCreatedAt":"2026-10-10T00:00:00Z","volumeName":"volume-original","networkName":"network-original"},
                  "original":{"volume":{"name":"volume-original","createdAt":"2026-10-10T00:00:00Z"},"network":{"name":"network-original","id":"f"*64}}}
        scope = {"projectId":"project-original","databaseId":"orders","commandId":"command-original","planDigest":"a"*64}
        result["receipt"].update(scope); result["original"].update(scope)
        module.validate_resource_receipt(result)
        for patch in [{"networkId":"e"*64},{"volumeCreatedAt":"2026-10-09T00:00:00Z"},{"networkId":None},{"volumeName":"foreign"}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError):
                module.validate_resource_receipt({**result,"receipt":{**result["receipt"],**patch}})

class NativeConnection(unittest.TestCase):
    def test_rejects_missing_unverified_or_foreign_connection_evidence(self):
        profile = {"profileId":"profile-postgres","engine":"postgres","containerPort":5432,"credentialKeys":["DATABASE_PASSWORD"]}
        receipt = {"projectId":"project-original","databaseId":"orders","planDigest":"a"*64,"networkName":"network-original","engine":"postgres"}
        connection = {"schemaVersion":1,"projectId":"project-original","databaseId":"orders","engine":"postgres","profileId":"profile-postgres",
            "planDigest":"a"*64,"availability":"planned","exposure":"internal","hostname":"db-orders","networkName":"network-original",
            "port":5432,"databaseName":"orders","username":"dl_"+"a"*12,"authenticationDatabase":None}
        good = {"receipt":receipt,"internalConnection":{"details":connection,"authenticatedRead":"passed","afterRestart":"passed"}}
        module.validate_internal_connection(good,profile)
        for patch in [{"internalConnection":None}, {"internalConnection":{**good["internalConnection"],"authenticatedRead":"not-run"}},
            *[{"internalConnection":{**good["internalConnection"],"details":{**connection,**change}}} for change in
              [{"projectId":"foreign"},{"networkName":"foreign"},{"hostname":"127.0.0.1"},{"port":9999},{"authenticationDatabase":"wrong"},{"password":"private"}]]]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError):
                module.validate_internal_connection({**good,**patch},profile)

class NativeStop(unittest.TestCase):
    def test_requires_executed_stop_of_the_same_original_daemon(self):
        result = {"receipt":{"containerId":"a"*64},"daemonStop":{"containerId":"a"*64,"status":"passed"}}
        module.validate_daemon_stop(result)
        for stop in [None, {"containerId":"b"*64,"status":"passed"}, {"containerId":"a"*64,"status":"not-run"}, {"containerId":"a"*64,"status":"passed","removed":True}]:
            with self.subTest(stop=stop), self.assertRaises(RuntimeError):
                module.validate_daemon_stop({**result,"daemonStop":stop})

class ConfiguredNativeStop(unittest.TestCase):
    def test_requires_bound_public_configured_stop_without_secrets(self):
        origin={"schemaVersion":1,"projectId":"project-original","databaseId":"orders","engine":"postgres","action":"database.runtime","agentId":"agent-original","commandId":"origin-original","inputDigest":"a"*64,"planDigest":"b"*64,"environmentFingerprint":"c"*32,"correlationId":"original-correlation",
                "containerId":"d"*64,"imageId":"sha256:"+"e"*64,"volumeName":"original-volume","networkName":"original-network","networkId":"f"*64,"volumeCreatedAt":"2026-10-10T00:00:00Z","observedAt":1000,"status":"ready","health":"passed","storage":"verified","idempotent":False,"redacted":True}
        profile={"profileId":"profile-original","engine":"postgres"}
        preparation={key:origin[key] for key in ("schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint")}
        apply_bound={**preparation,"profileId":profile["profileId"],"action":"project.update","scope":{"kind":"project","projectId":origin["projectId"]},"operation":"database.runtime.apply"}
        origin["inputDigest"]=hashlib.sha256(json.dumps(apply_bound,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        preparation.update(profileId=profile["profileId"],originalReceipt=origin,originalReplayFingerprint="1"*64)
        bound={**preparation,"action":"project.update","scope":{"kind":"project","projectId":origin["projectId"]},"operation":"database.runtime.stop"}
        digest=hashlib.sha256(json.dumps(bound,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        stopped={key:origin[key] for key in ("schemaVersion","projectId","databaseId","engine","agentId","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt","storage","redacted")}
        stopped.update(action="database.runtime.stop",commandId=origin["commandId"]+"-stop",originalCommandId=origin["commandId"],profileId=profile["profileId"],inputDigest=digest,correlationId=origin["commandId"]+"-stop",observedAt=2000,status="stopped")
        good={"receipt":origin,"nativeStop":{"receipt":stopped,"originalReplayFingerprint":"1"*64}}
        module.validate_configured_stop(good,profile)
        for patch in [{"nativeStop":None}, *[{"nativeStop":{**good["nativeStop"],"receipt":{**stopped,**change}}} for change in
            [{"commandId":origin["commandId"]},{"originalCommandId":"foreign"},{"networkId":"a"*64},{"profileId":"foreign"},{"inputDigest":"0"*64},{"observedAt":999},{"health":"passed"},{"password":"private"}]]]:
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):
                module.validate_configured_stop({**good,**patch},profile)

class NativeWorkflow(unittest.TestCase):
    def test_native_report_options_are_forwarded_to_vitest_and_verifier_always_runs(self):
        workflow = (Path(__file__).parents[2]/".github/workflows/baseline.yml").read_text()
        job = workflow.split("  p5-native-database-acceptance:\n",1)[1].split("  baseline-gate:\n",1)[0]
        self.assertIn("pnpm --filter @deploylite/agent exec vitest run --allowOnly=false --config vitest.config.ts",job)
        step = job.split("      - name: Refuse every omitted, skipped or incomplete native case\n",1)[1]
        self.assertTrue(step.startswith("        if: always()\n"))


class NativeRemoval(unittest.TestCase):
    def fixture(self):
        original={"containerId":"a"*64,"volumeName":"volume-original","networkName":"network-original","networkId":"b"*64,"volumeCreatedAt":"2026-10-10T00:00:00Z","observedAt":1000}
        return {"receipt":original,"daemonRemoval":{**{key:original[key] for key in ("containerId","volumeName","networkName","networkId","volumeCreatedAt")},"storage":"retained","observedAt":2000}}
    def test_requires_actual_removal_proof(self):
        result=self.fixture(); del result["daemonRemoval"]
        with self.assertRaises(RuntimeError): module.validate_daemon_removal(result)
    def test_accepts_exact_removed_original_and_retained_resources(self):
        module.validate_daemon_removal(self.fixture())
    def test_rejects_foreign_storage_unperformed_removal_and_private_fields(self):
        for patch in ({"containerId":"c"*64},{"volumeName":"foreign"},{"networkId":"c"*64},{"networkName":"foreign"},{"volumeCreatedAt":"other"},{"storage":"not-run"},{"password":"private"}):
            result=self.fixture(); result["daemonRemoval"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError): module.validate_daemon_removal(result)
    def test_rejects_unsafe_or_old_removal_clock(self):
        for value in (True,1.0,999,-1,9007199254740992):
            result=self.fixture(); result["daemonRemoval"]["observedAt"]=value
            with self.subTest(value=value),self.assertRaises(RuntimeError): module.validate_daemon_removal(result)

if __name__ == "__main__":
    unittest.main()
