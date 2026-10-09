"""Pure guard tests; the Docker boundary is never called from this file."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name("p3-compose-physical-acceptance.py")
SPEC = importlib.util.spec_from_file_location("p3_physical_acceptance", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HostedGateTests(unittest.TestCase):
    def test_import_and_missing_grant_do_not_spawn_processes(self):
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("process boundary called")):
            with self.assertRaisesRegex(MODULE.GateError, "explicit_p3_fixture_grant_required"):
                MODULE.native_context({})

    def test_wrong_runner_or_repository_fails_before_git_or_docker(self):
        env = {"DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT": "P3_COMPOSE_CI_APPROVED", "GITHUB_ACTIONS": "true",
               "GITHUB_EVENT_NAME": "pull_request", "RUNNER_ENVIRONMENT": "self-hosted", "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite"}
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("process boundary called")):
            with self.assertRaisesRegex(MODULE.GateError, "github_hosted_runner_required"):
                MODULE.native_context(env)
        env["RUNNER_ENVIRONMENT"] = "github-hosted"
        env["GITHUB_REPOSITORY"] = "attacker/DeployLite"
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("process boundary called")):
            with self.assertRaisesRegex(MODULE.GateError, "exact_repository_job_required"):
                MODULE.native_context(env)

    def test_native_context_accepts_internal_pr_on_any_branch_and_push_to_main(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            common = {"DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT": "P3_COMPOSE_CI_APPROVED", "GITHUB_ACTIONS": "true",
                      "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite",
                      "DEPLOYLITE_P3_HEAD_REPOSITORY": "DeployLiteApp/DeployLite", "GITHUB_JOB": "p3-docker-acceptance",
                      "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "DEPLOYLITE_P3_EXPECTED_SHA": "a" * 40,
                      "DOCKER_HOST": "unix:///var/run/docker.sock", "RUNNER_TEMP": temp_dir,
                      "DOCKER_CONFIG": f"{temp_dir}/deploylite-p3-empty-docker-config",
                      "DEPLOYLITE_P3_FIXTURE_MANIFEST": f"{temp_dir}/deploylite-p3-fixture-manifest.json"}
            contexts = (
                {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_HEAD_REF": "feature/p3-follow-up", "GITHUB_BASE_REF": "main"},
                {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main"},
            )
            for event_context in contexts:
                env = {**common, **event_context}
                with patch.object(MODULE.subprocess, "run", return_value=SimpleNamespace(stdout="a" * 40 + "\n")):
                    context = MODULE.native_context(env)
                self.assertEqual(context[0], Path(temp_dir))

    def test_fork_other_base_and_other_push_branch_fail_before_git_or_docker(self):
        cases = (
            ({"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "main", "DEPLOYLITE_P3_HEAD_REPOSITORY": "fork/DeployLite"}, "same_repository_head_required"),
            ({"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "release"}, "approved_main_event_required"),
            ({"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/feature/p3"}, "approved_main_event_required"),
            ({"GITHUB_EVENT_NAME": "pull_request_target", "GITHUB_BASE_REF": "main"}, "approved_main_event_required"),
        )
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("process boundary called")):
            for event_context, expected_gate in cases:
                env = {"DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT": "P3_COMPOSE_CI_APPROVED", "GITHUB_ACTIONS": "true",
                       "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite",
                       "DEPLOYLITE_P3_HEAD_REPOSITORY": "DeployLiteApp/DeployLite", "GITHUB_JOB": "p3-docker-acceptance",
                       **event_context}
                with self.assertRaisesRegex(MODULE.GateError, expected_gate):
                    MODULE.native_context(env)

    def test_source_manifest_is_fixed_and_hash_shaped(self):
        values = MODULE.sources()
        self.assertEqual(set(values), set(MODULE.SOURCE_FILES))
        self.assertGreaterEqual(len(values), 12)
        self.assertTrue(all(MODULE.HEX.fullmatch(value) for value in values.values()))

    def test_only_explicit_prepare_and_verify_actions_are_accepted(self):
        with patch.object(MODULE, "prepare", side_effect=AssertionError("prepare called")), patch.object(MODULE, "verify", side_effect=AssertionError("verify called")):
            with patch.object(MODULE.sys, "argv", [str(SOURCE), "cleanup"]):
                with self.assertRaisesRegex(MODULE.GateError, "explicit_action_required"):
                    MODULE.main()


if __name__ == "__main__":
    unittest.main(verbosity=2)
