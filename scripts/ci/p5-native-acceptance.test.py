import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
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

if __name__ == "__main__":
    unittest.main()
