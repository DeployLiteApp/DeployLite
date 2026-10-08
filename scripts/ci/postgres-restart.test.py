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

    def test_baseline_other_jobs_and_service_runtime_are_preserved(self):
        workflow = (Path(__file__).parents[2] / ".github/workflows/baseline.yml").read_text()
        self.assertIn("image: " + IMAGE, workflow)
        self.assertIn('ports: ["5432:5432"]', workflow)
        self.assertIn("--health-interval 5s --health-timeout 5s --health-retries 20", workflow)
        self.assertIn("  quality:\n", workflow)
        self.assertIn("  compose-and-supply-chain:\n", workflow)
        self.assertIn("  baseline-gate:\n", workflow)

    def test_noarg_entrypoint_fails_closed_with_explicit_not_verified_status(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}, clear=True), contextlib.redirect_stdout(output):
            with patch("subprocess.run", side_effect=AssertionError("No CLI allowed")) as runner:
                with self.assertRaises(SystemExit) as caught:
                    runpy.run_path(str(Path(__file__).with_name("postgres-restart.py")), run_name="__main__")
                self.assertEqual(caught.exception.code, 1)
                runner.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {"status": "not_verified", "reason": "invalid_ci_context"})

    def cleanup(self):
        return HELPER["cleanup"](CONTAINER, self.env, self.docker.run)

    def seed_evidence(self):
        self.restart()
        self.cleanup()
        self.env["GITHUB_SHA"] = "c" * 40
        manifest = json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
        digest = __import__("hashlib").sha256(b"recording source").hexdigest()
        binding = {"schemaVersion": 1, "repository": self.env["GITHUB_REPOSITORY"], "runId": self.env["GITHUB_RUN_ID"],
                   "runAttempt": self.env["GITHUB_RUN_ATTEMPT"], "job": self.env["GITHUB_JOB"], "commit": self.env["GITHUB_SHA"],
                   "startedAtMs": 900, "finishedAtMs": 2000, "sourceHashes": {p: digest for p in manifest["sourceFiles"]}, "reportHashes": {}}
        for suite in ("db", "api"):
            cases = manifest["suites"][suite]["cases"]
            report = {"success": True, "startTime": 1000, "numTotalTests": len(cases), "numPassedTests": len(cases),
                      "numPendingTests": 0, "numFailedTests": 0, "testResults": [{"startTime": 1000, "endTime": 1500,
                      "assertionResults": [{"fullName": c["fullName"], "title": c["title"], "status": "passed"} for c in cases]}]}
            path = self.directory / (suite + ".json")
            path.write_text(json.dumps(report))
            binding["reportHashes"][suite] = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
        (self.directory / "binding.json").write_text(json.dumps(binding))

    def test_cleanup_verifies_zero_owned_fixtures_without_deleting_foreign_data(self):
        receipt = self.cleanup()
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["fixtureDatabases"], 0)
        self.assertEqual(json.loads((self.directory / "cleanup.json").read_text()), receipt)
        self.assertEqual(self.docker.restarts(), [])
        sql = next(argv[-1] for argv, _ in self.docker.calls if argv[1] == "exec")
        self.assertEqual(sql, "SELECT count(*) FROM pg_database WHERE datname ~ '^(deploylite_verify_|deploylite_u2b_|deploylite_api_verify_)';")
        self.assertEqual(self.docker.fixtures, ["foreign-database", "deployliteXverify_foreign"])

    def test_cleanup_fails_on_each_owned_prefix_or_wrong_container_ownership(self):
        for name in ("deploylite_verify_123", "deploylite_u2b_123", "deploylite_api_verify_123"):
            with self.subTest(name=name):
                (self.directory / "cleanup.json").unlink(missing_ok=True)
                self.docker.fixtures = [name]
                with self.assertRaisesRegex(HELPER["RestartError"], "fixture_cleanup_not_verified"):
                    self.cleanup()
                self.assertEqual(json.loads((self.directory / "cleanup.json").read_text())["status"], "not_verified")
        (self.directory / "cleanup.json").unlink(missing_ok=True)
        self.docker.before["Labels"]["owner"] = "foreign"
        previous = len(self.docker.calls)
        with self.assertRaisesRegex(HELPER["RestartError"], "identity_mismatch"):
            self.cleanup()
        self.assertEqual(len(self.docker.calls), previous + 1)

    def test_evidence_gate_requires_physical_case_json_and_both_receipts(self):
        self.seed_evidence()
        self.assertTrue(HELPER["verify_evidence"](self.directory, CONTAINER, self.env, source_reader=lambda path: b"recording source", now_ms=2000))

    def test_evidence_gate_rejects_missing_failed_skipped_empty_or_mismatched_evidence(self):
        self.seed_evidence()
        originals = {name: (self.directory / name).read_text() for name in ("db.json", "api.json", "restart.json", "cleanup.json")}
        cases = [(name, None, None) for name in originals]
        cases += [(suite + ".json", field, value) for suite in ("db", "api") for field, value in
                  [("success", False), ("numTotalTests", 0), ("numPassedTests", 0), ("numPendingTests", 1), ("numFailedTests", 1), ("testResults", [])]]
        cases += [("restart.json", "status", "not_verified"), ("cleanup.json", "status", "not_verified"),
                  ("cleanup.json", "fixtureDatabases", 1), ("cleanup.json", "imageId", "sha256:" + "c" * 64),
                  ("restart.json", "containerId", "c" * 64), ("restart.json", "labels", {**LABELS, "run": "foreign"}),
                  ("restart.json", "afterStartedAt", self.docker.before["StartedAt"])]
        for name, field, value in cases:
            with self.subTest(name=name, field=field, value=value):
                path = self.directory / name
                data = json.loads(originals[name])
                if field is None:
                    path.unlink()
                else:
                    data[field] = value
                    path.write_text(json.dumps(data))
                self.assertFalse(HELPER["verify_evidence"](self.directory, CONTAINER, self.env, source_reader=lambda path: b"recording source", now_ms=2000))
                path.write_text(originals[name])
        for field, value in [("title", "different case"), ("status", "pending")]:
            with self.subTest(assertionField=field):
                data = json.loads(originals["db.json"])
                data["testResults"][0]["assertionResults"][0][field] = value
                (self.directory / "db.json").write_text(json.dumps(data))
                self.assertFalse(HELPER["verify_evidence"](self.directory, CONTAINER, self.env, source_reader=lambda path: b"recording source", now_ms=2000))

    def test_workflow_supplies_exact_service_and_scopes_restart_env_to_db_step(self):
        workflow = (Path(__file__).parents[2] / ".github/workflows/baseline.yml").read_text()
        pg_job = workflow.split("  postgres-integration:\n", 1)[1].split("  compose-and-supply-chain:\n", 1)[0]
        self.assertIn("--label io.deploylite.ci.owner=${{ github.repository }}", pg_job)
        self.assertIn("--label io.deploylite.ci.run=${{ github.run_id }}", pg_job)
        self.assertIn("--label io.deploylite.ci.attempt=${{ github.run_attempt }}", pg_job)
        self.assertIn("--label io.deploylite.ci.job=postgres-integration", pg_job)
        self.assertEqual(pg_job.count("DEPLOYLITE_PG_RESTART_HELPER:"), 1)
        self.assertIn("DEPLOYLITE_PG_CONTAINER_ID: ${{ job.services.postgres.id }}", pg_job)
        self.assertEqual(pg_job.count("--reporter=default --reporter=json"), 3)
        self.assertEqual(pg_job.count("@deploylite/db db:verify:integration"), 1)
        self.assertEqual(pg_job.count("@deploylite/api db:verify:integration"), 1)
        self.assertEqual(pg_job.count("@deploylite/db db:verify:compose"), 1)
        compose_step = pg_job.split("      - name: Verify P3 Compose atomic persistence", 1)[1].split("      - name: Verify suite fixture cleanup", 1)[0]
        self.assertIn("p3-compose-db.json", compose_step)
        self.assertNotIn("DEPLOYLITE_PG_RESTART_HELPER:", compose_step)
        self.assertNotIn("postgres-restart.py", compose_step)
        self.assertIn("--outputFile.json=", pg_job)
        self.assertIn("verify_evidence", pg_job)
        self.assertIn("if: always()", pg_job)
        self.assertIn("name: postgres-integration-reports", pg_job)

    def test_every_missing_inspected_field_and_helper_input_fails_before_restart(self):
        for field in self.docker.before.copy():
            with self.subTest(inspectField=field):
                self.reset_fake()
                self.docker.before.pop(field)
                self.assert_rejected("identity_mismatch")
        for field, reason in [("DEPLOYLITE_PG_CONTAINER_ID", "invalid_container_id"), ("DEPLOYLITE_PG_IMAGE", "invalid_service_image"),
                              ("RUNNER_TEMP", "unsafe_receipt_path"), ("DEPLOYLITE_PG_RECEIPT_DIR", "unsafe_receipt_path")]:
            with self.subTest(helperInput=field):
                original = self.env.copy()
                self.reset_fake()
                self.env.pop(field)
                self.assert_rejected(reason)
                self.env = original

    def test_malformed_selected_json_is_rejected_without_effects(self):
        for value in ("{bad-json", "null", "[]", "{}"):
            with self.subTest(value=value):
                self.reset_fake()
                self.docker.raw_inspect = value
                self.assert_rejected("identity_mismatch")

    def test_restart_and_final_version_commands_have_effective_timeouts(self):
        for delays in ([0, 0, 9], [0, 0, 0, 0, 9]):
            with self.subTest(delays=delays):
                self.reset_fake()
                self.docker.delays = list(delays)
                self.assert_rejected("docker_command_failed", restarts=1)
                self.assertLessEqual(self.docker.now, 20)
                self.assertTrue(all(kwargs["timeout"] <= 6 for _, kwargs in self.docker.calls))

    def test_cleanup_subprocess_error_leaves_redacted_not_verified_receipt(self):
        self.docker.error = subprocess.CalledProcessError(1, ["docker", "exec"], stderr="sensitive-secret")
        self.docker.error_on = "exec"
        with self.assertRaisesRegex(HELPER["RestartError"], "docker_command_failed"):
            self.cleanup()
        receipt = (self.directory / "cleanup.json").read_text()
        self.assertEqual(json.loads(receipt)["status"], "not_verified")
        self.assertNotIn("sensitive-secret", receipt)
        self.assertEqual(self.docker.restarts(), [])

    def test_evidence_gate_rejects_invalid_json_and_symlink_files(self):
        self.seed_evidence()
        path = self.directory / "db.json"
        original = path.read_text()
        path.write_text("{bad-json")
        self.assertFalse(HELPER["verify_evidence"](self.directory, CONTAINER, self.env, source_reader=lambda path: b"recording source", now_ms=2000))
        path.unlink()
        foreign = Path(self.temp.name) / "foreign.json"
        foreign.write_text(original)
        path.symlink_to(foreign)
        self.assertFalse(HELPER["verify_evidence"](self.directory, CONTAINER, self.env, source_reader=lambda path: b"recording source", now_ms=2000))



class ProspectiveEvidenceContractTests(unittest.TestCase):
    """Exact report/binding guards. NOT RUN; every restart process is a fake."""
    setUp = RestartTests.setUp
    restart = RestartTests.restart
    cleanup = RestartTests.cleanup
    def seed_current(self):
        manifest=json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
        self.restart();self.cleanup();self.env["GITHUB_SHA"]="c"*40
        digest=__import__("hashlib").sha256(b"recording source").hexdigest()
        binding={"schemaVersion":1,"repository":self.env["GITHUB_REPOSITORY"],"runId":self.env["GITHUB_RUN_ID"],
                 "runAttempt":self.env["GITHUB_RUN_ATTEMPT"],"job":self.env["GITHUB_JOB"],"commit":self.env["GITHUB_SHA"],
                 "startedAtMs":900,"finishedAtMs":2000,"sourceHashes":{p:digest for p in manifest["sourceFiles"]},"reportHashes":{}}
        for suite in ("db","api"):
            cases=manifest["suites"][suite]["cases"]
            assertions=[{"fullName":c["fullName"],"title":c["title"],"status":"passed"} for c in cases]
            report={"success":True,"startTime":1000,"numTotalTests":len(cases),"numPassedTests":len(cases),"numPendingTests":0,"numFailedTests":0,
                    "testResults":[{"startTime":1000,"endTime":1500,"assertionResults":assertions}]}
            path=self.directory/(suite+".json");path.write_text(json.dumps(report))
            binding["reportHashes"][suite]=__import__("hashlib").sha256(path.read_bytes()).hexdigest()
        (self.directory/"binding.json").write_text(json.dumps(binding));return manifest
    def verify(self):
        return HELPER["verify_evidence"](self.directory,CONTAINER,self.env,source_reader=lambda path:b"recording source",now_ms=2000)
    def mutate(self,suite,change):
        path=self.directory/(suite+".json");report=json.loads(path.read_text());change(report);path.write_text(json.dumps(report))
        binding=json.loads((self.directory/"binding.json").read_text());binding["reportHashes"][suite]=__import__("hashlib").sha256(path.read_bytes()).hexdigest();(self.directory/"binding.json").write_text(json.dumps(binding))
    def test_rejects_historical_db35_even_with_the_single_restart_and_matching_receipts(self):
        self.seed_current()
        def old(report):
            cases=report["testResults"][0]["assertionResults"];report["testResults"][0]["assertionResults"]=[c for c in cases if c["title"]==HELPER["CASE"]]+[c for c in cases if c["title"]!=HELPER["CASE"]][:34];report.update(numTotalTests=35,numPassedTests=35)
        self.mutate("db",old);self.assertFalse(self.verify());self.assertEqual(len(self.docker.restarts()),1)
    def test_rejects_historical_api2_even_if_every_auth_assertion_passed(self):
        self.seed_current();self.mutate("api",lambda r:(r["testResults"][0].update(assertionResults=r["testResults"][0]["assertionResults"][:2]),r.update(numTotalTests=2,numPassedTests=2)));self.assertFalse(self.verify())
    def test_rejects_duplicate_full_names_with_unchanged_passing_count(self):
        self.seed_current();self.mutate("db",lambda r:r["testResults"][0]["assertionResults"].__setitem__(0,copy.deepcopy(r["testResults"][0]["assertionResults"][1])));self.assertFalse(self.verify())
    def test_rejects_unreviewed_title_replacement_in_an_otherwise_passing_report(self):
        self.seed_current();self.mutate("api",lambda r:r["testResults"][0]["assertionResults"][0].update(fullName="unreviewed alternate source"));self.assertFalse(self.verify())
    def test_rejects_missing_job_source_binding_even_when_physical_receipts_match(self):
        self.seed_current();(self.directory/"binding.json").unlink();self.assertFalse(self.verify())
    def test_rejects_wrong_repository_run_attempt_job_or_commit_binding(self):
        self.seed_current();path=self.directory/"binding.json";original=path.read_text()
        for field in ("repository","runId","runAttempt","job","commit"):
            with self.subTest(field=field):
                binding=json.loads(original);binding[field]="foreign";path.write_text(json.dumps(binding));self.assertFalse(self.verify())
        path.write_text(original)
    def test_rejects_report_older_than_current_same_job_capture(self):
        self.seed_current();self.mutate("db",lambda r:r.update(startTime=800));self.assertFalse(self.verify())
    def test_rejects_changed_source_hash_or_removed_source_scope(self):
        self.seed_current();path=self.directory/"binding.json";original=path.read_text()
        for hashes in ({}, {**json.loads(original)["sourceHashes"],"foreign.ts":"e"*64}):
            with self.subTest(hashes=hashes):
                binding=json.loads(original);binding["sourceHashes"]=hashes;path.write_text(json.dumps(binding));self.assertFalse(self.verify())
    def test_rejects_source_reader_drift_after_report_even_when_binding_was_valid(self):
        self.seed_current();self.assertFalse(HELPER["verify_evidence"](self.directory,CONTAINER,self.env,source_reader=lambda path:b"changed source",now_ms=2000))
    def test_rejects_report_hash_mismatch_in_a_valid_job_binding(self):
        self.seed_current();path=self.directory/"binding.json";binding=json.loads(path.read_text());binding["reportHashes"]["db"]="e"*64;path.write_text(json.dumps(binding));self.assertFalse(self.verify())
    def test_characterizes_full_db49_api6_fixture_with_one_existing_restart_lifecycle(self):
        self.seed_current();self.assertTrue(self.verify());self.assertEqual(len(self.docker.restarts()),1)

if __name__ == "__main__":
    unittest.main(verbosity=2)
