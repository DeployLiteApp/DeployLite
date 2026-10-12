"""Explicit isolated five-engine fixture admission; no Docker execution or ambient credential lookup."""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[2]
ENGINES = ("postgres", "mysql", "mariadb", "mongodb", "redis")

def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)

def checkout_sha(root, env):
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, env={"PATH": env.get("PATH", "/usr/bin:/bin")}, check=True, text=True, capture_output=True, timeout=5).stdout.strip()

def native_context(env, root=ROOT):
    require(env.get("DEPLOYLITE_P5_NATIVE_RUNTIME_GRANT") == "P5_NATIVE_CI_APPROVED", "explicit_native_fixture_grant_required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted", "hosted_runner_required")
    require(env.get("GITHUB_REPOSITORY") == env.get("DEPLOYLITE_P5_HEAD_REPOSITORY") == "DeployLiteApp/DeployLite"
            and env.get("GITHUB_JOB") == "p5-native-database-acceptance", "exact_owned_repository_job_required")
    event = env.get("GITHUB_EVENT_NAME")
    require(event == "pull_request" and bool(env.get("GITHUB_BASE_REF")) or event == "push" and env.get("GITHUB_REF") == "refs/heads/main", "owned_pr_or_main_event_required")
    require(all(re.fullmatch(r"[1-9][0-9]*", env.get(key, "")) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "run_identity_required")
    head = env.get("DEPLOYLITE_P5_EXPECTED_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", head) and checkout_sha(root, env) == head, "exact_source_required")
    require(env.get("DOCKER_HOST") == "unix:///var/run/docker.sock" and not any(env.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "hosted_socket_only")
    require(not env.get("DATABASE_URL") and env.get("DEPLOYLITE_DB_INTEGRATION") != "1" and env.get("DEPLOYLITE_API_DB_INTEGRATION") != "1", "control_plane_database_forbidden")
    temp = Path(env.get("RUNNER_TEMP", ""))
    require(temp.is_absolute() and temp.is_dir() and not temp.is_symlink() and temp.stat().st_uid == os.getuid(), "owned_temp_required")
    config = Path(env.get("DOCKER_CONFIG", ""))
    require(config == temp / "deploylite-p5-native-empty-docker-config", "exact_private_config_required")
    require(config.is_dir() and not config.is_symlink() and config.stat().st_uid == os.getuid() and config.stat().st_mode & 0o777 == 0o700
            and not list(config.iterdir()), "empty_owned_private_config_required")
    return {"repository": env["GITHUB_REPOSITORY"], "job": env["GITHUB_JOB"], "runId": env["GITHUB_RUN_ID"], "runAttempt": env["GITHUB_RUN_ATTEMPT"], "commit": head}

def validate_profiles(manifest):
    require(manifest.get("schemaVersion") == 1 and manifest.get("fixtureOnly") is True, "fixture_only_manifest_required")
    profiles = manifest.get("profiles", {})
    require(set(profiles) == set(ENGINES), "exact_five_engines_required")
    repositories = {"postgres":"postgres", "mysql":"mysql", "mariadb":"mariadb", "mongodb":"mongo", "redis":"redis"}
    for engine, profile in profiles.items():
        require(profile["engine"] == engine and re.fullmatch("docker.io/library/" + repositories[engine] + r"@sha256:[a-f0-9]{64}", profile["image"]), "exact_official_pinned_fixture_required")
    return profiles

def validate_resource_receipt(result):
    require(isinstance(result,dict), "original_native_resources_required")
    receipt, original = result.get("receipt"), result.get("original")
    require(isinstance(receipt,dict) and isinstance(original,dict), "original_native_resources_required")
    volume, network = original.get("volume"), original.get("network")
    require(isinstance(volume,dict) and isinstance(network,dict), "original_native_resources_required")
    require(all(isinstance(receipt.get(key),str) and receipt[key] and receipt[key] == original.get(key)
                for key in ("projectId","databaseId","commandId","planDigest")), "original_native_resource_scope_required")
    require(isinstance(receipt.get("networkId"),str) and re.fullmatch(r"[a-f0-9]{64}",receipt["networkId"])
            and receipt["networkId"] == network.get("id"), "original_native_network_identity_required")
    created = receipt.get("volumeCreatedAt")
    require(isinstance(created,str) and created == volume.get("createdAt"), "original_native_volume_identity_required")
    try:
        require(datetime.fromisoformat(created.replace("Z","+00:00")).tzinfo is not None, "native_volume_timestamp_required")
    except ValueError:
        require(False, "native_volume_timestamp_required")
    require(all(isinstance(receipt.get(key),str) and receipt[key] and receipt[key] == resource.get("name")
                for key,resource in (("volumeName",volume),("networkName",network))), "original_native_resource_names_required")

def capture(env):
    require(sys.platform == "linux", "hosted_linux_required")
    context = native_context(env)
    profiles = validate_profiles(json.loads((ROOT / "scripts/ci/p5-native-profiles.json").read_text()))
    sources = json.loads((ROOT / "scripts/ci/p2-acceptance-cases.json").read_text())["sourceFiles"] + [
        "scripts/ci/p5-native-acceptance.py", "scripts/ci/p5-native-profiles.json", "apps/agent/src/infrastructure/docker/docker-managed-database-native.physical.test.ts"]
    hashes = {}
    for name in sorted(set(sources)):
        path = ROOT / name
        require(not Path(name).is_absolute() and ".." not in Path(name).parts and path.is_file() and not path.is_symlink(), "declared_source_required")
        require(ROOT in path.resolve().parents, "repository_source_only")
        data = path.read_bytes()
        original = subprocess.run(["git", "show", context["commit"] + ":" + name], cwd=ROOT, check=True, capture_output=True, timeout=5).stdout
        require(data == original, "unchanged_exact_source_required")
        hashes[name] = hashlib.sha256(data).hexdigest()
    nonce = secrets.token_hex(12)
    directory = Path(env["RUNNER_TEMP"]) / "deploylite-p5-native-evidence"
    directory.mkdir(mode=0o700, exist_ok=False)
    value = {"schemaVersion":1, **context, "nonce":nonce, "owner":"ci-p5-" + context["runId"] + "-" + context["runAttempt"] + "-" + nonce,
             "engines":list(ENGINES), "sourceHashes":hashes, "profiles":profiles, "admission":"prepared"}
    path = directory / "binding.json"
    path.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(path, 0o600)
    print("Captured exact isolated native fixture scope; no Docker effect performed.")

def validate_report(report):
    require(report.get("success") is True and all(report.get(key) == count for key,count in
            (("numTotalTests",5),("numPassedTests",5),("numFailedTests",0),("numPendingTests",0))), "five_executed_passing_cases_required")
    cases = [case for suite in report.get("testResults",[]) for case in suite.get("assertionResults",[])]
    expected = {"native five-engine physical " + engine + " startup and persistence" for engine in ENGINES}
    require(len(cases) == 5 and {case.get("fullName") for case in cases} == expected and all(case.get("status") == "passed" for case in cases), "exact_five_native_titles_required")

def verify(env):
    require(sys.platform == "linux", "hosted_linux_required")
    context = native_context(env)
    directory = Path(env["RUNNER_TEMP"]) / "deploylite-p5-native-evidence"
    binding = json.loads((directory / "binding.json").read_text())
    require(all(binding.get(key) == value for key,value in context.items()), "original_run_source_binding_required")
    for name,digest in binding["sourceHashes"].items():
        require(hashlib.sha256((ROOT/name).read_bytes()).hexdigest() == digest, "unchanged_source_required")
    report = json.loads((directory / "native.json").read_text())
    validate_report(report)
    acceptance = json.loads((directory / "acceptance.json").read_text())
    require(acceptance.get("status") == "passed" and all(acceptance.get(key) == binding[key] for key in ("commit","runId","runAttempt","nonce")), "original_native_acceptance_required")
    require(set(acceptance.get("engines",{})) == set(ENGINES), "all_native_engines_required")
    for engine,item in acceptance["engines"].items():
        result = item.get("result",{})
        receipt = result.get("receipt",{})
        validate_resource_receipt(result)
        require(item.get("cleanup") == "verified" and all(result.get(key) == "passed" for key in ("authenticatedProbe","restart","persistence")), "native_persistence_cleanup_required")
        require(type(result.get("uid")) is int and 0 < result["uid"] <= 4294967294 and receipt.get("engine") == engine and receipt.get("status") == "ready"
                and receipt.get("health") == "passed" and receipt.get("storage") == "verified" and receipt.get("redacted") is True, "ready_nonroot_native_receipt_required")
        require(re.fullmatch(r"[a-f0-9]{64}",receipt.get("containerId","")) and re.fullmatch(r"sha256:[a-f0-9]{64}",receipt.get("imageId","")), "original_native_identity_required")
    proof = {"schemaVersion":1,**context,"nonce":binding["nonce"],"status":"verified","cases":5,
             "artifactHashes":{name:hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ("binding.json","native.json","acceptance.json")}}
    (directory / "verified.json").write_text(json.dumps(proof,indent=2)+"\n")
    print("Verified five executed native startup/persistence cases and scoped cleanup.")

if __name__ == "__main__":
    require(len(sys.argv) == 2 and sys.argv[1] in ("capture","verify"), "explicit_fixture_operation_required")
    (capture if sys.argv[1] == "capture" else verify)(dict(os.environ))
