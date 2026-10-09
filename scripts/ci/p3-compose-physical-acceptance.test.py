"""Pure guard tests; the Docker boundary is never called from this file."""
import importlib.util
from pathlib import Path
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

    def test_wrong_pr_source_fails_before_git_or_docker(self):
        env = {"DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT": "P3_COMPOSE_CI_APPROVED", "GITHUB_ACTIONS": "true",
               "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "DeployLiteApp/DeployLite",
               "DEPLOYLITE_P3_HEAD_REPOSITORY": "DeployLiteApp/DeployLite", "GITHUB_EVENT_NAME": "pull_request",
               "GITHUB_JOB": "p3-docker-acceptance", "GITHUB_HEAD_REF": "main", "GITHUB_BASE_REF": "main"}
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("process boundary called")):
            with self.assertRaisesRegex(MODULE.GateError, "exact_candidate_pr_required"):
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
