"""Separate hosted operator fixture admission; direct native no-control-DB guard stays unchanged."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("p5-native-acceptance.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
IMAGE = "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
JOB = "p5-native-operator-acceptance"
DIRECTORY = "deploylite-p5-operator-evidence"
CONFIG = "deploylite-p5-operator-empty-docker-config"

def operator_context(env, root=ROOT):
    native.require(sys.platform == "linux", "hosted_linux_required")
    native.require(env.get("DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT") == "P5_OPERATOR_CI_APPROVED", "explicit_operator_fixture_grant_required")
    native.require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted", "hosted_runner_required")
    native.require(env.get("GITHUB_REPOSITORY") == env.get("DEPLOYLITE_P5_HEAD_REPOSITORY") == "DeployLiteApp/DeployLite"
        and env.get("GITHUB_JOB") == JOB, "exact_owned_operator_job_required")
    event = env.get("GITHUB_EVENT_NAME")
    native.require(event == "pull_request" and bool(env.get("GITHUB_BASE_REF"))
        or event == "push" and env.get("GITHUB_REF") == "refs/heads/main", "owned_pr_or_main_event_required")
    native.require(all(re.fullmatch(r"[1-9][0-9]*", env.get(key, "")) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "run_identity_required")
    head = env.get("DEPLOYLITE_P5_EXPECTED_SHA", "")
    native.require(re.fullmatch(r"[a-f0-9]{40}", head) and native.checkout_sha(root, env) == head, "exact_operator_source_required")
    native.require(env.get("DOCKER_HOST") == "unix:///var/run/docker.sock"
        and not any(env.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "hosted_socket_only")
    identifier, port = env.get("DEPLOYLITE_P5_OPERATOR_PG_ID", ""), env.get("DEPLOYLITE_P5_OPERATOR_PG_PORT", "")
    native.require(re.fullmatch(r"[a-f0-9]{64}", identifier) and re.fullmatch(r"[1-9][0-9]{3,4}", port)
        and 1024 <= int(port) <= 65535, "exact_ephemeral_postgres_service_required")
    native.require(env.get("DATABASE_URL") == f"postgres://deploylite:deploylite-ci-only@127.0.0.1:{port}/deploylite", "exact_fixture_database_address_required")
    temp = Path(env.get("RUNNER_TEMP", ""))
    native.require(temp.is_absolute() and temp.is_dir() and not temp.is_symlink()
        and temp.stat().st_uid == os.getuid(), "owned_temp_required")
    config = Path(env.get("DOCKER_CONFIG", ""))
    native.require(config == temp / CONFIG and config.is_dir() and not config.is_symlink()
        and config.stat().st_uid == os.getuid() and config.stat().st_mode & 0o777 == 0o700
        and not list(config.iterdir()), "empty_owned_operator_config_required")
    return {"repository": env["GITHUB_REPOSITORY"], "job": JOB, "runId": env["GITHUB_RUN_ID"],
        "runAttempt": env["GITHUB_RUN_ATTEMPT"], "commit": head, "postgresContainerId": identifier, "postgresPort": int(port)}

def validate_service(context, row):
    keys = {"id", "image", "repository", "job", "runId", "runAttempt", "running", "bindings"}
    native.require(isinstance(row, dict) and set(row) == keys, "safe_postgres_projection_required")
    expected = {"id": context["postgresContainerId"], "image": IMAGE, "repository": context["repository"],
        "job": JOB, "runId": context["runId"], "runAttempt": context["runAttempt"], "running": True}
    native.require(all(row.get(key) == value for key, value in expected.items()) and row["running"] is True,
        "original_owned_postgres_service_required")
    bindings = row["bindings"]
    native.require(isinstance(bindings, list) and 1 <= len(bindings) <= 2, "exact_postgres_public_binding_required")
    addresses = set()
    for binding in bindings:
        native.require(isinstance(binding, dict) and set(binding) == {"HostIp", "HostPort"}
            and binding["HostIp"] in {"0.0.0.0", "::", "127.0.0.1"}
            and binding["HostIp"] not in addresses and binding["HostPort"] == str(context["postgresPort"]), "exact_postgres_public_binding_required")
        addresses.add(binding["HostIp"])
    return row

def inspect_service(env, context):
    # Explicit public projection only: never read Config.Env or container logs.
    projection = '{"id":{{json .Id}},"image":{{json .Config.Image}},"repository":{{json (index .Config.Labels "io.deploylite.ci.owner")}},"job":{{json (index .Config.Labels "io.deploylite.ci.job")}},"runId":{{json (index .Config.Labels "io.deploylite.ci.run")}},"runAttempt":{{json (index .Config.Labels "io.deploylite.ci.attempt")}},"running":{{json .State.Running}},"bindings":{{json (index .NetworkSettings.Ports "5432/tcp")}}}'
    result = subprocess.run(["docker", "inspect", "--type=container", "--format", projection, context["postgresContainerId"]],
        env={"PATH": env.get("PATH", "/usr/bin:/bin"), "DOCKER_HOST": env["DOCKER_HOST"], "DOCKER_CONFIG": env["DOCKER_CONFIG"]},
        check=True, text=True, capture_output=True, timeout=15)
    native.require(len(result.stdout.encode()) <= 8192, "bounded_postgres_projection_required")
    return validate_service(context, json.loads(result.stdout))

def source_hashes(context, root=ROOT):
    names = json.loads((root / "scripts/ci/p2-acceptance-cases.json").read_text())["sourceFiles"]
    names += [path.relative_to(root).as_posix() for path in (root / "packages/db/migrations").glob("*.sql")]
    hashes = {}
    for name in sorted(set(names)):
        path = root / name
        native.require(not Path(name).is_absolute() and ".." not in Path(name).parts and path.is_file()
            and not path.is_symlink() and root in path.resolve().parents, "repository_source_only")
        data = path.read_bytes()
        original = subprocess.run(["git", "show", context["commit"] + ":" + name], cwd=root,
            check=True, capture_output=True, timeout=5).stdout
        native.require(data == original, "unchanged_operator_source_required")
        hashes[name] = hashlib.sha256(data).hexdigest()
    return hashes

def capture(env):
    context = operator_context(env)
    service = inspect_service(env, context)
    hashes = source_hashes(context)
    profiles = native.validate_profiles(json.loads((ROOT / "scripts/ci/p5-native-profiles.json").read_text()))
    nonce = secrets.token_hex(12)
    directory = Path(env["RUNNER_TEMP"]) / DIRECTORY
    directory.mkdir(mode=0o700, exist_ok=False)
    binding = {"schemaVersion": 1, **context, "nonce": nonce, "databaseName": "deploylite_p5_operator_" + nonce,
        "postgres": service, "profiles": profiles, "sourceHashes": hashes, "admission": "prepared"}
    descriptor = os.open(directory / "binding.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(binding, sort_keys=True, indent=2) + "\n")
    return binding

def load(env):
    context = operator_context(env)
    directory = Path(env["RUNNER_TEMP"]) / DIRECTORY
    path = directory / "binding.json"
    native.require(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == os.getuid()
        and directory.stat().st_mode & 0o777 == 0o700 and path.is_file() and not path.is_symlink()
        and path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o777 == 0o600, "private_original_operator_binding_required")
    binding = json.loads(path.read_text())
    keys = set(context) | {"schemaVersion", "nonce", "databaseName", "postgres", "profiles", "sourceHashes", "admission"}
    native.require(set(binding) == keys and binding["schemaVersion"] == 1 and binding["admission"] == "prepared"
        and all(binding.get(key) == value for key, value in context.items())
        and re.fullmatch(r"[a-f0-9]{24}", binding["nonce"])
        and binding["databaseName"] == "deploylite_p5_operator_" + binding["nonce"], "unchanged_operator_binding_required")
    native.require(inspect_service(env, context) == binding["postgres"] and source_hashes(context) == binding["sourceHashes"],
        "unchanged_operator_service_and_source_required")
    native.require(native.validate_profiles({"schemaVersion": 1, "fixtureOnly": True, "profiles": binding["profiles"]})
        == native.validate_profiles(json.loads((ROOT / "scripts/ci/p5-native-profiles.json").read_text())), "unchanged_five_engine_profiles_required")
    return binding

if __name__ == "__main__":
    native.require(len(sys.argv) == 2 and sys.argv[1] in {"capture", "check"}, "capture_or_check_required")
    result = capture(os.environ) if sys.argv[1] == "capture" else load(os.environ)
    print(json.dumps({"status": "prepared", "commit": result["commit"], "job": JOB}))
