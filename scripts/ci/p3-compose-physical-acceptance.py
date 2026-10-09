"""Prepare and verify the exact-run, hosted-only P3 Compose Docker fixture.

Import and verification are effect free. Docker is reachable only through the
explicit prepare/cleanup actions after all hosted-job and source gates pass.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = "docker.io/library/busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092"
REGISTRY = "docker.io/library/registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8"
SOURCE_FILES = (
    "apps/agent/src/agent-transport.ts",
    "apps/agent/src/infrastructure/docker/compose-resource-cleanup-config.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-resource-cleanup.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-resource-inspector.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-network-attachment.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-volume-backup.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-volume-attachment.ts",
    "apps/agent/src/infrastructure/docker/docker-compose-volume-replacement-driver.ts",
    "apps/agent/src/server.ts",
    "apps/api/src/agent-transport.ts",
    "apps/api/src/app.ts",
    "apps/api/src/compose-resource-cleanup-route.ts",
    "apps/api/src/compose-resource-docker.integration.test.ts",
    "apps/api/src/compose-resource-runtime.ts",
    "packages/contracts/src/deployment-contract/compose-resource-cleanup.ts",
    "packages/contracts/src/compose/resource-cleanup.ts",
    "packages/contracts/src/index.ts",
    "scripts/ci/p3-compose-physical-acceptance.py",
    "scripts/testing/p2-fixture/.dockerignore",
    "scripts/testing/p2-fixture/Dockerfile",
    "scripts/testing/p2-fixture/a/version",
    "scripts/testing/p2-fixture/healthz",
)
HEX = re.compile(r"^[a-f0-9]{64}$")


class GateError(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise GateError(message)


def approved_main_event(env):
    event = env.get("GITHUB_EVENT_NAME")
    if event == "pull_request":
        return env.get("GITHUB_BASE_REF") == "main"
    if event == "push":
        return env.get("GITHUB_REF") == "refs/heads/main"
    return False


def native_context(env):
    require(env.get("DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT") == "P3_COMPOSE_CI_APPROVED", "explicit_p3_fixture_grant_required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted", "github_hosted_runner_required")
    require(env.get("GITHUB_REPOSITORY") == "DeployLiteApp/DeployLite" and env.get("GITHUB_JOB") == "p3-docker-acceptance", "exact_repository_job_required")
    require(env.get("DEPLOYLITE_P3_HEAD_REPOSITORY") == "DeployLiteApp/DeployLite", "same_repository_head_required")
    require(approved_main_event(env), "approved_main_event_required")
    require(re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", "")) and re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ATTEMPT", "")), "run_identity_required")
    expected = env.get("DEPLOYLITE_P3_EXPECTED_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", expected), "exact_head_sha_required")
    require(env.get("DOCKER_HOST") == "unix:///var/run/docker.sock" and not any(env.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "hosted_socket_only")
    require(not env.get("DATABASE_URL") and env.get("DEPLOYLITE_DB_INTEGRATION") != "1" and env.get("DEPLOYLITE_API_DB_INTEGRATION") != "1", "database_scope_forbidden")
    temp = Path(env.get("RUNNER_TEMP", ""))
    require(temp.is_absolute() and temp.is_dir() and not temp.is_symlink() and temp.stat().st_uid == os.getuid(), "owned_runner_temp_required")
    config = Path(env.get("DOCKER_CONFIG", ""))
    require(config == temp / "deploylite-p3-empty-docker-config", "exact_private_docker_config_required")
    manifest = Path(env.get("DEPLOYLITE_P3_FIXTURE_MANIFEST", ""))
    require(manifest == temp / "deploylite-p3-fixture-manifest.json", "exact_private_manifest_required")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, env={"PATH": env.get("PATH", "/usr/bin:/bin")},
                          check=True, text=True, capture_output=True, timeout=5).stdout.strip()
    require(head == expected, "checkout_must_be_exact_pr_head")
    return temp, config, manifest


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    require(path.is_dir() and not path.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private_owned_directory_required")


def sources():
    values = {}
    for relative in SOURCE_FILES:
        path = ROOT / relative
        require(path.is_file() and not path.is_symlink(), "fixture_source_missing_or_symlink")
        values[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return values


def private_json(path, value):
    require(not path.exists() and not path.is_symlink(), "refuse_overwrite_fixture_evidence")
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def docker(config, host, args, timeout=60):
    argv = ["docker", "--config", str(config), "--host", host, *args]
    try:
        result = subprocess.run(argv, cwd=ROOT, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C", "LC_ALL": "C"},
                                text=True, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        raise GateError("owned_docker_outcome_unknown") from None
    require(result.returncode == 0 and len(result.stdout) <= 65536 and len(result.stderr) <= 65536, "owned_docker_command_failed_or_unbounded")
    return result.stdout.strip()


def manifest_digest(repository, timeout=10):
    request = urllib.request.Request(f"http://127.0.0.1:49172/v2/{repository}/manifests/prepared", headers={
        "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(1_048_577)
            require(len(body) <= 1_048_576, "fixture_manifest_too_large")
            digest = response.headers.get("Docker-Content-Digest", "")
    except (OSError, urllib.error.URLError, TimeoutError):
        raise GateError("owned_loopback_registry_readback_failed") from None
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "observed_registry_manifest_digest_required")
    require(hashlib.sha256(body).hexdigest() == digest.removeprefix("sha256:"), "registry_manifest_bytes_digest_mismatch")
    return digest


def prepare(env):
    temp, config, manifest_path = native_context(env)
    require(not manifest_path.exists(), "refuse_manifest_overwrite")
    evidence_dir = temp / "deploylite-p3-evidence"
    require(not evidence_dir.exists(), "refuse_evidence_overwrite")
    evidence_dir.mkdir(mode=0o700)
    private_directory(evidence_dir)
    private_directory(config, create=True)
    require(list(config.iterdir()) == [], "docker_config_must_be_empty")
    run_id = env["GITHUB_RUN_ID"] + "-" + env["GITHUB_RUN_ATTEMPT"]
    safe_id = re.sub(r"[^a-z0-9-]", "-", run_id.lower())
    owner, project = "p3-ci-" + safe_id, "p3c8-" + safe_id
    network_name, registry_name = "deploylite-p3-prep-" + safe_id, "deploylite-p3-registry-" + safe_id
    source_hashes = sources()
    engine = docker(config, env["DOCKER_HOST"], ["info", "--format", "{{.ID}} {{.OSType}} {{.Architecture}}"]).split()
    require(len(engine) == 3 and re.fullmatch(r"[A-Za-z0-9_-]{12,128}", engine[0]) and engine[1:] == ["linux", "x86_64"], "hosted_engine_identity_mismatch")
    for image in (BASE, REGISTRY):
        docker(config, env["DOCKER_HOST"], ["pull", "--platform", "linux/amd64", image], timeout=90)
    network_id = docker(config, env["DOCKER_HOST"], ["network", "create", "--driver", "bridge", "--label", f"com.deploylite.owner={owner}",
                                                       "--label", f"com.deploylite.project={project}", "--label", "com.deploylite.p3.prep=true", network_name])
    require(re.fullmatch(r"[a-f0-9]{64}", network_id), "owned_prep_network_id_required")
    preparation_network_id = network_id
    registry_id = ""
    try:
        registry_id = docker(config, env["DOCKER_HOST"], ["run", "--detach", "--name", registry_name, "--network", network_name,
            "--publish", "127.0.0.1:49172:5000", "--cpus=0.25", "--memory=67108864", "--pids-limit=32", "--read-only",
            "--tmpfs", "/var/lib/registry:rw,noexec,nosuid,size=67108864", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--restart", "no", "--label", f"com.deploylite.owner={owner}", "--label", f"com.deploylite.project={project}", "--label", "com.deploylite.p3.prep=true", REGISTRY])
        require(re.fullmatch(r"[a-f0-9]{64}", registry_id), "owned_registry_container_id_required")
        preparation_registry_id = registry_id
        registry_image_id = docker(config, env["DOCKER_HOST"], ["image", "inspect", "--format", "{{.Id}}", REGISTRY])
        base_image_id = docker(config, env["DOCKER_HOST"], ["image", "inspect", "--format", "{{.Id}}", BASE])
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", registry_image_id) and re.fullmatch(r"sha256:[a-f0-9]{64}", base_image_id), "pinned_input_image_identity_required")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:49172/v2/", timeout=1) as response:
                    require(response.status == 200, "owned_registry_health_failed")
                    break
            except (OSError, urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        else:
            raise GateError("owned_registry_readiness_timeout")
        repository = "deploylite-p3/" + safe_id
        tag = "127.0.0.1:49172/" + repository + ":prepared"
        docker(config, env["DOCKER_HOST"], ["build", "--pull=false", "--network=none", "--platform", "linux/amd64", "--target", "a", "--tag", tag, "scripts/testing/p2-fixture"], timeout=120)
        docker(config, env["DOCKER_HOST"], ["push", tag], timeout=90)
        reference = "127.0.0.1:49172/" + repository + "@" + manifest_digest(repository)
        docker(config, env["DOCKER_HOST"], ["pull", "--platform", "linux/amd64", reference], timeout=90)
        image_id = docker(config, env["DOCKER_HOST"], ["image", "inspect", "--format", "{{.Id}}", reference])
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id), "exact_pulled_image_id_required")
        # Remove the only preparation container and network before the product test starts.
        docker(config, env["DOCKER_HOST"], ["container", "rm", "--force", registry_id])
        registry_id = ""
        docker(config, env["DOCKER_HOST"], ["network", "rm", network_id])
        network_id = ""
        require(docker(config, env["DOCKER_HOST"], ["container", "ls", "--all", "--filter", f"name=^{registry_name}$", "--format", "{{.ID}}"]) == "", "preparation_container_cleanup_unverified")
        require(docker(config, env["DOCKER_HOST"], ["network", "ls", "--filter", f"name=^{network_name}$", "--format", "{{.ID}}"]) == "", "preparation_network_cleanup_unverified")
        private_json(manifest_path, {"schemaVersion": 1, "repository": env["GITHUB_REPOSITORY"], "commit": env["DEPLOYLITE_P3_EXPECTED_SHA"],
            "runId": env["GITHUB_RUN_ID"], "runAttempt": env["GITHUB_RUN_ATTEMPT"], "job": env["GITHUB_JOB"], "engineId": engine[0],
            "dockerHost": env["DOCKER_HOST"], "image": reference, "imageId": image_id, "platform": "linux/amd64", "sourceHashes": source_hashes,
            "preparation": {"baseImage": BASE, "baseImageId": base_image_id, "registryImage": REGISTRY, "registryImageId": registry_image_id,
                "networkName": network_name, "networkId": preparation_network_id, "registryContainerName": registry_name,
                "registryContainerId": preparation_registry_id, "loopbackPort": 49172, "cleanupVerified": True}})
        return {"status": "prepared", "imageId": image_id, "sourceCount": len(source_hashes), "preparationCleanup": "verified"}
    finally:
        if registry_id:
            docker(config, env["DOCKER_HOST"], ["container", "rm", "--force", registry_id])
        if network_id:
            docker(config, env["DOCKER_HOST"], ["network", "rm", network_id])


def verify(env):
    temp, config, manifest_path = native_context(env)
    private_directory(config)
    info = manifest_path.lstat()
    require(manifest_path.is_file() and not manifest_path.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private_manifest_required")
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get("schemaVersion") == 1 and manifest.get("commit") == env["DEPLOYLITE_P3_EXPECTED_SHA"] and manifest.get("sourceHashes") == sources(), "manifest_source_or_head_mismatch")
    evidence_dir = temp / "deploylite-p3-evidence"
    evidence_path = evidence_dir / "compose-acceptance.json"
    report_path = evidence_dir / "docker.json"
    require(evidence_path.is_file() and report_path.is_file(), "acceptance_evidence_missing")
    evidence = json.loads(evidence_path.read_text())
    report = json.loads(report_path.read_text())
    require(evidence.get("status") == "PASS" and evidence.get("repository") == manifest["repository"] and evidence.get("commit") == manifest["commit"]
            and evidence.get("runId") == manifest["runId"] and evidence.get("runAttempt") == manifest["runAttempt"] and evidence.get("image") == manifest["image"]
            and evidence.get("imageId") == manifest["imageId"] and evidence.get("sourceHashes") == manifest["sourceHashes"], "same_run_acceptance_binding_failed")
    cases = [case for result in report.get("testResults", []) for case in result.get("assertionResults", [])]
    expected_case = "P3 C3-C8 disposable Docker acceptance binds observed ownership, network changes, volume replacement, backup and confirmed cleanup to one exact run"
    require(report.get("success") is True and report.get("numTotalTests") == report.get("numPassedTests") == 1
            and report.get("numFailedTests") == report.get("numPendingTests") == 0 and len(cases) == 1
            and cases[0].get("status") == "passed" and cases[0].get("fullName") == expected_case, "exact_physical_case_not_passed")
    statuses = {item.get("operation"): item.get("status") for item in evidence.get("operations", [])}
    required = {"C3 owned network and volume identities", "C4 network attach", "C4 network detach", "C4 bounded volume replacement",
                "C5 actual observation", "C6 stopped volume backup and integrity", "C8 exact-source integrated fixture binding"}
    require(required.issubset(statuses) and all(statuses[name] == "PASS" for name in required), "p3_acceptance_operation_missing")
    cleanup = evidence.get("cleanup", [])
    cleanups = [item for item in evidence.get("operations", []) if str(item.get("operation", "")).startswith("C7 confirmed ")]
    require(len(cleanup) == 3 and {item.get("kind") for item in cleanup} == {"network", "volume"}
            and all(item.get("verifiedAbsent") is True for item in cleanup) and len(cleanups) == 3
            and all(item.get("status") == "PASS" and item.get("receipt", {}).get("terminalStatus") == "removed" for item in cleanups),
            "exact_resource_cleanup_not_verified")
    require(all(resource.get("created") is False for resource in evidence.get("resources", [])), "owned_resource_lifecycle_not_closed")
    receipt = {"status": "verified", "repository": manifest["repository"], "commit": manifest["commit"], "runId": manifest["runId"],
        "runAttempt": manifest["runAttempt"], "job": manifest["job"], "engineId": manifest["engineId"], "image": manifest["image"],
        "sourceHashes": manifest["sourceHashes"], "reportSha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
        "acceptanceSha256": hashlib.sha256(evidence_path.read_bytes()).hexdigest(), "cleanupCount": len(cleanup)}
    private_json(evidence_dir / "verified.json", receipt)
    return receipt


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("prepare", "verify"), "explicit_action_required")
    action = sys.argv[1]
    print(json.dumps(prepare(dict(os.environ)) if action == "prepare" else verify(dict(os.environ)), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (GateError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "not_verified", "reason": str(error)}))
        sys.exit(1)
