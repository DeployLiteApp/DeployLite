"""Behavioral tests with an entirely simulated Docker subprocess boundary."""
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HELPER = runpy.run_path(str(Path(__file__).with_name("postgres-restart.py")))
IMAGE = HELPER["IMAGE"]
CONTAINER = "a" * 64
LABELS = {"owner": "DeployLiteApp/DeployLite", "run": "123", "attempt": "2", "job": "postgres-integration"}


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.now = 0
        self.before = {"Id": CONTAINER, "Image": "sha256:" + "b" * 64, "DeclaredImage": IMAGE,
                       "Labels": LABELS.copy(), "StartedAt": "2026-10-04T01:00:00.000000000Z", "Health": "healthy"}
        self.after = copy.deepcopy(self.before)
        self.after["StartedAt"] = "2026-10-04T01:00:01.000000000Z"
        self.restarted = False
        self.error = None
        self.latency = 0
        self.version = "16.14"
        self.after_version = "16.14"
        self.health = []
        self.fixtures = ["foreign-database", "deployliteXverify_foreign"]
        self.delays = []
        self.raw_inspect = None
        self.error_on = "restart"

    def run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        latency = self.delays.pop(0) if self.delays else self.latency
        self.now += min(latency, kwargs["timeout"])
        if latency >= kwargs["timeout"]:
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
        if self.error and argv[1] == self.error_on:
            raise self.error
        if argv[1] == "inspect":
            data = copy.deepcopy(self.after if self.restarted else self.before)
            if self.restarted and self.health:
                data["Health"] = self.health.pop(0)
            output = json.dumps(data) if self.raw_inspect is None else self.raw_inspect
        elif argv[1] == "restart":
            self.restarted = True
            output = CONTAINER
        elif argv[1] == "exec":
            if argv[-1] == "SHOW server_version":
                output = (self.after_version if self.restarted else self.version) + "\n"
            else:
                prefixes = ("deploylite_verify_", "deploylite_u2b_", "deploylite_api_verify_")
                output = str(sum(name.startswith(prefixes) for name in self.fixtures)) + "\n"
        else:
            raise AssertionError("Unexpected fake subprocess command")
        return subprocess.CompletedProcess(argv, 0, output, "")

    def sleep(self, seconds):
        self.now += seconds

    def restarts(self):
        return [argv for argv, _ in self.calls if argv[1] == "restart"]


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "deploylite-postgres-evidence"
        self.env = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": LABELS["owner"],
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": LABELS["job"],
                    "RUNNER_TEMP": self.temp.name, "DEPLOYLITE_PG_CONTAINER_ID": CONTAINER,
                    "DEPLOYLITE_PG_IMAGE": IMAGE, "DEPLOYLITE_PG_RECEIPT_DIR": str(self.directory),
                    "DATABASE_URL": "postgres://sensitive-secret@localhost/never-print"}
        self.docker = FakeDocker()

    def restart(self):
        return HELPER["restart"](self.env, self.docker.run, lambda: self.docker.now, self.docker.sleep)

    def assert_rejected(self, reason, restarts=0):
        error = None
        try:
            self.restart()
        except Exception as caught:
            error = caught
        self.assertIsInstance(error, HELPER["RestartError"])
        self.assertEqual(str(error), reason)
        self.assertEqual(len(self.docker.restarts()), restarts)

    def reset_fake(self):
        self.docker = FakeDocker()
        (self.directory / "restart.json").unlink(missing_ok=True)

    def test_nonhosted_and_missing_ci_context_reject_before_restart(self):
        cases = [(key, None) for key in ("GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")]
        cases += [("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"), ("GITHUB_JOB", "quality"),
                  ("GITHUB_RUN_ID", "not-numeric"), ("GITHUB_RUN_ATTEMPT", "0"), ("GITHUB_REPOSITORY", "../foreign")]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                original = self.env.copy()
                self.reset_fake()
                self.env.pop(key) if value is None else self.env.update({key: value})
                self.assert_rejected("invalid_ci_context")
                self.env = original

    def test_malformed_ids_and_declared_image_reject_before_restart(self):
        for key, value, reason in [("DEPLOYLITE_PG_CONTAINER_ID", value, "invalid_container_id") for value in ("", "abc", "a" * 63, "A" * 64, "--all")]:
            with self.subTest(value=value):
                self.reset_fake()
                self.env[key] = value
                self.assert_rejected(reason)
        self.env["DEPLOYLITE_PG_CONTAINER_ID"] = CONTAINER
        self.env["DEPLOYLITE_PG_IMAGE"] = "postgres:16-alpine"
        self.reset_fake()
        self.assert_rejected("invalid_service_image")

    def test_every_owner_label_mismatch_rejects_before_restart(self):
        for key in LABELS:
            for value in (None, "foreign"):
                with self.subTest(key=key, value=value):
                    self.reset_fake()
                    self.docker.before["Labels"][key] = value
                    self.assert_rejected("identity_mismatch")

    def test_malformed_or_wrong_inspected_fields_reject_before_restart(self):
        for field, value in [("Id", "c" * 64), ("Image", "sha256:bad"), ("DeclaredImage", "postgres:15"),
                             ("Labels", None), ("StartedAt", "bad-date"), ("Health", "starting")]:
            with self.subTest(field=field):
                self.reset_fake()
                self.docker.before[field] = value
                self.assert_rejected("identity_mismatch")
        self.reset_fake()
        self.docker.version = "15.9"
        self.assert_rejected("server_version_mismatch")

    def test_postrestart_id_image_labels_and_version_are_revalidated(self):
        for field, value in [("Id", "c" * 64), ("Image", "sha256:" + "d" * 64),
                             ("DeclaredImage", "postgres:15"), ("Labels", {**LABELS, "run": "foreign"})]:
            with self.subTest(field=field):
                self.reset_fake()
                self.docker.after[field] = value
                self.assert_rejected("identity_mismatch", restarts=1)
        self.reset_fake()
        self.docker.after_version = "16.15"
        self.assert_rejected("server_version_mismatch", restarts=1)

    def test_readiness_poll_waits_for_health_and_changed_started_at(self):
        self.docker.health = ["starting", "starting", "healthy"]
        receipt = self.restart()
        self.assertEqual(receipt["status"], "verified")
        self.assertGreater(self.docker.now, 0)
        self.assertNotEqual(receipt["beforeStartedAt"], receipt["afterStartedAt"])

    def test_unchanged_start_or_unready_health_exhausts_bounded_deadline(self):
        for field, value in [("StartedAt", self.docker.before["StartedAt"]), ("Health", "starting")]:
            with self.subTest(field=field):
                self.reset_fake()
                self.docker.after[field] = value
                self.assert_rejected("deadline_exceeded", restarts=1)
                self.assertLessEqual(self.docker.now, 20)
                receipt = json.loads((self.directory / "restart.json").read_text())
                self.assertEqual(receipt["status"], "not_verified")

    def test_subprocess_failure_is_redacted_and_not_verified(self):
        self.docker.error = subprocess.CalledProcessError(1, ["docker", "restart"], stderr="sensitive-secret")
        self.assert_rejected("docker_command_failed", restarts=1)
        receipt = (self.directory / "restart.json").read_text()
        self.assertNotIn("sensitive-secret", receipt)
        self.assertEqual(json.loads(receipt)["status"], "not_verified")

    def test_subprocess_timeouts_and_total_deadline_bound_all_commands(self):
        self.docker.latency = 9
        self.assert_rejected("docker_command_failed")
        self.assertLessEqual(self.docker.now, 20)

    def test_total_deadline_limits_inspect_restart_and_poll_budget(self):
        self.reset_fake()
        self.docker.latency = 2.9
        self.docker.after["Health"] = "starting"
        self.assert_rejected("deadline_exceeded", restarts=1)
        self.assertLessEqual(self.docker.now, 20)

    def test_receipt_path_and_existing_files_reject_before_restart(self):
        self.env["DEPLOYLITE_PG_RECEIPT_DIR"] = str(Path(self.temp.name) / "foreign")
        self.assert_rejected("unsafe_receipt_path")

    def test_existing_regular_receipt_is_not_overwritten(self):
        self.directory.mkdir()
        receipt = self.directory / "restart.json"
        receipt.write_text("preserve-existing")
        self.assert_rejected("unsafe_receipt_path")
        self.assertEqual(receipt.read_text(), "preserve-existing")

    def test_existing_symlink_receipt_is_not_followed(self):
        self.directory.mkdir()
        receipt = self.directory / "restart.json"
        receipt.symlink_to(Path(self.temp.name) / "foreign-file")
        self.assert_rejected("unsafe_receipt_path")
        self.assertFalse((Path(self.temp.name) / "foreign-file").exists())

    def test_symlink_evidence_directory_rejects_before_restart(self):
        foreign = Path(self.temp.name) / "foreign"
        foreign.mkdir()
        self.directory.symlink_to(foreign, target_is_directory=True)
        self.assert_rejected("unsafe_receipt_path")
        self.assertFalse((foreign / "restart.json").exists())

    def test_single_owned_restart_produces_nontrivial_redacted_receipt(self):
        receipt = self.restart()
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(self.docker.restarts(), [["docker", "restart", "--time", "3", CONTAINER]])
        self.assertEqual(receipt["imageId"], self.docker.before["Image"])
        self.assertEqual(receipt["serverVersion"], "16.14")
        self.assertEqual(json.loads((self.directory / "restart.json").read_text()), receipt)
        self.assertNotIn("sensitive-secret", json.dumps(receipt))


if __name__ == "__main__":
    unittest.main(verbosity=2)
