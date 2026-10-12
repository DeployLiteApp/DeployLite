import importlib.util
import os
import json
import hashlib
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("operator", Path(__file__).with_name("p5-operator-admission.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class OperatorAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / module.CONFIG
        self.config.mkdir(mode=0o700)
        self.env = {"DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT": "P5_OPERATOR_CI_APPROVED", "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite",
            "DEPLOYLITE_P5_HEAD_REPOSITORY": "DeployLiteApp/DeployLite", "GITHUB_JOB": module.JOB,
            "GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "feat/p5-native-stop-route",
            "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "DEPLOYLITE_P5_EXPECTED_SHA": "a" * 40,
            "DOCKER_HOST": "unix:///var/run/docker.sock", "RUNNER_TEMP": str(self.root), "DOCKER_CONFIG": str(self.config),
            "DEPLOYLITE_P5_OPERATOR_PG_ID": "b" * 64, "DEPLOYLITE_P5_OPERATOR_PG_PORT": "15432",
            "DATABASE_URL": "postgres://deploylite:deploylite-ci-only@127.0.0.1:15432/deploylite"}
        self.git = patch.object(module.native, "checkout_sha", return_value="a" * 40)
        self.git.start()
        self.linux = patch.object(module.sys, "platform", "linux")
        self.linux.start()
        self.context = {"repository": "DeployLiteApp/DeployLite", "job": module.JOB, "runId": "123", "runAttempt": "1",
            "commit": "a" * 40, "postgresContainerId": "b" * 64, "postgresPort": 15432}
        self.service = {"id": "b" * 64, "image": module.IMAGE, "repository": "DeployLiteApp/DeployLite", "job": module.JOB,
            "runId": "123", "runAttempt": "1", "running": True, "bindings": [{"HostIp": "0.0.0.0", "HostPort": "15432"}]}
    def tearDown(self):
        self.linux.stop()
        self.git.stop()
        self.temp.cleanup()
    def test_exact_hosted_operator_scope_and_ephemeral_service_address(self):
        self.assertEqual(module.operator_context(self.env, self.root), self.context)
    def test_rejects_foreign_runner_job_fork_event_or_missing_grant(self):
        for key, value in {"DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT": "", "GITHUB_ACTIONS": "false",
            "RUNNER_ENVIRONMENT": "self-hosted", "GITHUB_JOB": "p5-native-database-acceptance",
            "GITHUB_REPOSITORY": "foreign/repo", "DEPLOYLITE_P5_HEAD_REPOSITORY": "foreign/repo",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ID": "0", "GITHUB_RUN_ATTEMPT": "0"}.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.operator_context({**self.env, key: value}, self.root)
    def test_rejects_external_or_mismatched_database_and_docker_addresses(self):
        for key, value in {"DATABASE_URL": "postgres://protected", "DEPLOYLITE_P5_OPERATOR_PG_ID": "foreign",
            "DEPLOYLITE_P5_OPERATOR_PG_PORT": "543", "DOCKER_HOST": "ssh://host", "DOCKER_CONTEXT": "shared",
            "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "private", "DEPLOYLITE_P5_EXPECTED_SHA": "c" * 40}.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.operator_context({**self.env, key: value}, self.root)
    def test_requires_empty_owned_private_config(self):
        (self.config / "config.json").write_text("{}")
        with self.assertRaises(RuntimeError): module.operator_context(self.env, self.root)
    def test_requires_exact_owned_service_projection(self):
        self.assertEqual(module.validate_service(self.context, self.service), self.service)
    def test_rejects_replaced_foreign_stopped_or_wrong_image_service(self):
        for key, value in {"id": "c" * 64, "image": "postgres:latest", "repository": "foreign/repo", "job": "other",
            "runId": "124", "runAttempt": "2", "running": False, "bindings": [{"HostIp": "0.0.0.0", "HostPort": "5432"}]}.items():
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.validate_service(self.context, {**self.service, key: value})
    def test_rejects_service_environment_and_unknown_projection_fields(self):
        with self.assertRaises(RuntimeError): module.validate_service(self.context, {**self.service, "environment": ["private"]})

    def prepared(self):
        profiles = json.loads((module.ROOT / "scripts/ci/p5-native-profiles.json").read_text())
        path = self.root / "scripts/ci/p5-native-profiles.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(profiles))
        return profiles
    def test_capture_and_load_keep_only_private_original_public_binding(self):
        self.prepared()
        with patch.object(module, "ROOT", self.root), patch.object(module, "inspect_service", return_value=self.service), \
            patch.object(module, "source_hashes", return_value={"source.ts": "c" * 64}), patch.object(module.secrets, "token_hex", return_value="d" * 24):
            binding = module.capture(self.env)
            self.assertEqual(module.load(self.env), binding)
            self.assertEqual(binding["databaseName"], "deploylite_p5_operator_" + "d" * 24)
            self.assertNotIn("DATABASE_URL", binding)
            self.assertNotIn("password", json.dumps(binding))
            directory = self.root / module.DIRECTORY
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual((directory / "binding.json").stat().st_mode & 0o777, 0o600)
    def test_load_rejects_changed_binding_source_service_or_private_fields(self):
        self.prepared()
        with patch.object(module, "ROOT", self.root), patch.object(module, "inspect_service", return_value=self.service) as inspector, \
            patch.object(module, "source_hashes", return_value={"source.ts": "c" * 64}) as hashes:
            binding = module.capture(self.env)
            path = self.root / module.DIRECTORY / "binding.json"
            for change in [{"nonce": "foreign"}, {"databaseName": "protected"}, {"password": "private"}, {"commit": "e" * 40}]:
                path.write_text(json.dumps({**binding, **change}))
                inspector.reset_mock()
                with self.subTest(change=change), self.assertRaises(RuntimeError): module.load(self.env)
                inspector.assert_not_called()
            path.write_text(json.dumps(binding))
            hashes.return_value = {"source.ts": "f" * 64}
            with self.assertRaises(RuntimeError): module.load(self.env)
            hashes.return_value = binding["sourceHashes"]
            inspector.return_value = {**self.service, "id": "f" * 64}
            with self.assertRaises(RuntimeError): module.load(self.env)
    def test_source_hashes_bind_exact_git_bytes(self):
        self.prepared()
        path = self.root / "source.ts"
        path.write_bytes(b"original source")
        (self.root / "scripts/ci/p2-acceptance-cases.json").write_text(json.dumps({"sourceFiles": ["source.ts"]}))
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(stdout=b"original source")) as process:
            self.assertEqual(module.source_hashes(self.context, self.root), {"source.ts": hashlib.sha256(b"original source").hexdigest()})
            self.assertEqual(process.call_args.args[0], ["git", "show", self.context["commit"] + ":source.ts"])
            process.return_value.stdout = b"changed source"
            with self.assertRaises(RuntimeError): module.source_hashes(self.context, self.root)
    def test_source_hashes_refuse_symlinks_and_parent_paths_before_process(self):
        self.prepared()
        target = self.root / "original.ts"
        target.write_text("source")
        (self.root / "link.ts").symlink_to(target)
        for name in ["link.ts", "../original.ts", str(target)]:
            (self.root / "scripts/ci/p2-acceptance-cases.json").write_text(json.dumps({"sourceFiles": [name]}))
            with self.subTest(name=name), patch.object(module.subprocess, "run") as process, self.assertRaises(RuntimeError):
                module.source_hashes(self.context, self.root)
            process.assert_not_called()

    def test_source_hashes_include_every_migration_before_database_use(self):
        self.prepared()
        migration = self.root / "packages/db/migrations/0000_fixture.sql"
        migration.parent.mkdir(parents=True)
        migration.write_bytes(b"fixture migration")
        (self.root / "scripts/ci/p2-acceptance-cases.json").write_text(json.dumps({"sourceFiles": []}))
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(stdout=b"fixture migration")):
            self.assertEqual(module.source_hashes(self.context, self.root), {
                "packages/db/migrations/0000_fixture.sql": hashlib.sha256(b"fixture migration").hexdigest()})

if __name__ == "__main__":
    unittest.main()
