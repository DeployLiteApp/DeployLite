"""Restart only the explicitly identified hosted-CI PostgreSQL service."""
import json
import hashlib
import datetime
import os
from pathlib import Path
import re
import subprocess
import sys
import time

IMAGE = "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
CASE = "retains proof, command and canonical origin across an owned server restart"
FORMAT = ('{"Id":{{json .Id}},"Image":{{json .Image}},"DeclaredImage":{{json .Config.Image}},'
          '"Labels":{"owner":{{json (index .Config.Labels "io.deploylite.ci.owner")}},'
          '"run":{{json (index .Config.Labels "io.deploylite.ci.run")}},'
          '"attempt":{{json (index .Config.Labels "io.deploylite.ci.attempt")}},'
          '"job":{{json (index .Config.Labels "io.deploylite.ci.job")}}},'
          '"StartedAt":{{json .State.StartedAt}},'
          '"Health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}')


class RestartError(RuntimeError):
    pass


def context(env):
    owner = env.get("GITHUB_REPOSITORY", "")
    run = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or env.get("GITHUB_JOB") != "postgres-integration" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", owner)
            or not re.fullmatch(r"[1-9][0-9]*", run) or not re.fullmatch(r"[1-9][0-9]*", attempt)):
        raise RestartError("invalid_ci_context")
    container = env.get("DEPLOYLITE_PG_CONTAINER_ID", "")
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise RestartError("invalid_container_id")
    if env.get("DEPLOYLITE_PG_IMAGE") != IMAGE:
        raise RestartError("invalid_service_image")
    return container, {"owner": owner, "run": run, "attempt": attempt, "job": env["GITHUB_JOB"]}


def receipt_file(env, name):
    """Reserve an exclusive file through directory descriptors; never follow links."""
    root = Path(env.get("RUNNER_TEMP", ""))
    directory = Path(env.get("DEPLOYLITE_PG_RECEIPT_DIR", ""))
    if (not root.is_absolute() or not root.is_dir() or root.is_symlink()
            or directory != root / "deploylite-postgres-evidence" or directory.is_symlink()):
        raise RestartError("unsafe_receipt_path")
    try:
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.mkdir(directory.name, mode=0o700, dir_fd=root_fd)
            except FileExistsError:
                pass
            directory_fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            os.close(root_fd)
    except OSError:
        raise RestartError("unsafe_receipt_path") from None
    return os.fdopen(fd, "w")


def write_receipt(file, receipt):
    file.seek(0)
    file.truncate()
    file.write(json.dumps(receipt, sort_keys=True) + "\n")
    file.flush()


def validate(info, container, labels, image_id=None, require_healthy=False):
    try:
        valid = (info["Id"] == container and info["Labels"] == labels and info["DeclaredImage"] == IMAGE
                 and re.fullmatch(r"sha256:[a-f0-9]{64}", info["Image"])
                 and (image_id is None or info["Image"] == image_id)
                 and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z", info["StartedAt"])
                 and datetime.datetime.fromisoformat(info["StartedAt"].replace("Z", "+00:00")).year >= 1970
                 and info["Health"] in ("starting", "healthy", "unhealthy")
                 and (not require_healthy or info["Health"] == "healthy"))
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise RestartError("identity_mismatch")


def restart(env=None, runner=subprocess.run, clock=time.monotonic, sleep=time.sleep):
    env = os.environ if env is None else env
    deadline = clock() + 20
    container, labels = context(env)

    def remaining():
        budget = deadline - clock()
        if budget <= 0:
            raise RestartError("deadline_exceeded")
        return budget

    def command(*args):
        timeout = min(6 if args[0] == "restart" else 3, remaining())
        try:
            result = runner(["docker", *args], check=True, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
        except (OSError, subprocess.SubprocessError):
            remaining()
            raise RestartError("docker_command_failed") from None
        remaining()
        return result.stdout.strip()

    def inspect():
        try:
            return json.loads(command("inspect", "--type=container", "--format", FORMAT, container))
        except json.JSONDecodeError:
            raise RestartError("identity_mismatch") from None

    def version():
        value = command("exec", container, "psql", "-U", "deploylite", "-d", "postgres", "-Atqc", "SHOW server_version")
        if not re.fullmatch(r"16\.\d+", value):
            raise RestartError("server_version_mismatch")
        return value

    with receipt_file(env, "restart.json") as file:
        write_receipt(file, {"status": "not_verified"})
        try:
            before = inspect()
            validate(before, container, labels, require_healthy=True)
            before_version = version()
            command("restart", "--time", "3", container)
            while True:
                after = inspect()
                validate(after, container, labels, image_id=before["Image"])
                if after["Health"] == "healthy" and after["StartedAt"] != before["StartedAt"]:
                    break
                sleep(min(0.5, remaining()))
            if version() != before_version:
                raise RestartError("server_version_mismatch")
            receipt = {"status": "verified", "containerId": container, "imageId": before["Image"], "imageRef": IMAGE,
                       "labels": labels, "beforeStartedAt": before["StartedAt"], "afterStartedAt": after["StartedAt"],
                       "health": after["Health"], "serverVersion": before_version, "deadlineSeconds": 20}
            write_receipt(file, receipt)
            return receipt
        except RestartError as error:
            write_receipt(file, {"status": "not_verified", "reason": str(error)})
            raise


def cleanup(container, env=None, runner=subprocess.run):
    """Verify fixture absence on this service; GitHub owns container cleanup."""
    env = dict(os.environ if env is None else env)
    env.update(DEPLOYLITE_PG_CONTAINER_ID=container, DEPLOYLITE_PG_IMAGE=IMAGE,
               DEPLOYLITE_PG_RECEIPT_DIR=str(Path(env.get("RUNNER_TEMP", "")) / "deploylite-postgres-evidence"))
    container, labels = context(env)

    def command(*args):
        try:
            return runner(["docker", *args], check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=3).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            raise RestartError("docker_command_failed") from None

    with receipt_file(env, "cleanup.json") as file:
        write_receipt(file, {"status": "not_verified"})
        try:
            try:
                info = json.loads(command("inspect", "--type=container", "--format", FORMAT, container))
            except json.JSONDecodeError:
                raise RestartError("identity_mismatch") from None
            validate(info, container, labels, require_healthy=True)
            sql = "SELECT count(*) FROM pg_database WHERE datname ~ '^(deploylite_verify_|deploylite_u2b_|deploylite_api_verify_)';"
            if command("exec", container, "psql", "-U", "deploylite", "-d", "postgres", "-Atqc", sql) != "0":
                raise RestartError("fixture_cleanup_not_verified")
            receipt = {"status": "verified", "fixtureDatabases": 0, "containerId": container,
                       "imageId": info["Image"], "labels": labels}
            write_receipt(file, receipt)
            return receipt
        except RestartError as error:
            write_receipt(file, {"status": "not_verified", "reason": str(error)})
            raise


def evidence_manifest():
    return json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())


def source_hashes(manifest, reader=None):
    reader = reader or (lambda path: Path(path).read_bytes())
    root = Path(__file__).resolve().parents[2]
    return {relative: hashlib.sha256(reader(root / relative)).hexdigest() for relative in manifest["sourceFiles"]}


def report_matches(report, suite):
    expected = [case["fullName"] for case in suite["cases"]]
    titles = {case["fullName"]: case["title"] for case in suite["cases"]}
    assertions = [case for result in report["testResults"] for case in result["assertionResults"]]
    names = [case["fullName"] for case in assertions]
    return (report["success"] is True and type(report["numTotalTests"]) is int
            and report["numTotalTests"] == report["numPassedTests"] == suite["count"]
            and report["numPendingTests"] == report["numFailedTests"] == 0
            and len(names) == len(set(names)) == len(expected) and set(names) == set(expected)
            and all(case["status"] == "passed" and case["title"] == titles[case["fullName"]] for case in assertions))


def capture_binding(directory, container, env=None):
    env = dict(os.environ if env is None else env)
    env.update(DEPLOYLITE_PG_CONTAINER_ID=container, DEPLOYLITE_PG_IMAGE=IMAGE,
               DEPLOYLITE_PG_RECEIPT_DIR=str(directory))
    _, labels = context(env)
    manifest = evidence_manifest()
    if not re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")):
        raise RestartError("invalid_commit_binding")
    binding = {"schemaVersion": 1, "repository": labels["owner"], "runId": labels["run"],
               "runAttempt": labels["attempt"], "job": labels["job"], "commit": env["GITHUB_SHA"],
               "startedAtMs": time.time() * 1000, "sourceHashes": source_hashes(manifest), "reportHashes": {}}
    with receipt_file(env, "binding.json") as file:
        write_receipt(file, binding)
    return binding


def complete_binding(directory, container, env=None):
    env = dict(os.environ if env is None else env)
    env.update(DEPLOYLITE_PG_CONTAINER_ID=container, DEPLOYLITE_PG_IMAGE=IMAGE)
    _, labels = context(env)
    directory = Path(directory)
    if directory != Path(env["RUNNER_TEMP"]) / "deploylite-postgres-evidence" or directory.is_symlink():
        raise RestartError("unsafe_receipt_path")
    path = directory / "binding.json"
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+") as file:
        binding = json.load(file)
        expected = {"repository": labels["owner"], "runId": labels["run"], "runAttempt": labels["attempt"], "job": labels["job"], "commit": env.get("GITHUB_SHA")}
        if any(binding.get(key) != value for key, value in expected.items()) or binding.get("finishedAtMs") is not None:
            raise RestartError("invalid_job_binding")
        if binding["sourceHashes"] != source_hashes(evidence_manifest()):
            raise RestartError("source_changed_during_acceptance")
        for suite in ("db", "api"):
            report = directory / (suite + ".json")
            if not report.is_file() or report.is_symlink():
                raise RestartError("missing_evidence")
            binding["reportHashes"][suite] = hashlib.sha256(report.read_bytes()).hexdigest()
        binding["finishedAtMs"] = time.time() * 1000
        write_receipt(file, binding)
    return binding


def verify_evidence(directory, container, env=None, source_reader=None, now_ms=None):
    """Require executed, passing suites and nontrivial same-run physical receipts."""
    env = dict(os.environ if env is None else env)
    env.update(DEPLOYLITE_PG_CONTAINER_ID=container, DEPLOYLITE_PG_IMAGE=IMAGE)
    directory = Path(directory)
    try:
        container, labels = context(env)
        if directory != Path(env["RUNNER_TEMP"]) / "deploylite-postgres-evidence" or directory.is_symlink():
            return False

        def load(name):
            path = directory / name
            if not path.is_file() or path.is_symlink():
                raise RestartError("missing_evidence")
            return json.loads(path.read_text())

        manifest = evidence_manifest()
        binding = load("binding.json")
        expected_binding = {"repository": labels["owner"], "runId": labels["run"], "runAttempt": labels["attempt"], "job": labels["job"], "commit": env.get("GITHUB_SHA")}
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        if (binding.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", ""))
                or any(binding.get(key) != value for key, value in expected_binding.items())
                or binding.get("sourceHashes") != source_hashes(manifest, source_reader)
                or not binding["startedAtMs"] <= binding["finishedAtMs"] <= now_ms <= binding["finishedAtMs"] + 600000):
            return False
        for suite in ("db", "api"):
            report = load(suite + ".json")
            if (not report_matches(report, manifest["suites"][suite])
                    or binding["reportHashes"][suite] != hashlib.sha256((directory / (suite + ".json")).read_bytes()).hexdigest()
                    or not binding["startedAtMs"] <= report["startTime"] <= binding["finishedAtMs"]
                    or any(not binding["startedAtMs"] <= result["startTime"] <= result["endTime"] <= binding["finishedAtMs"] for result in report["testResults"])):
                return False
            total = report["numTotalTests"]
            assertions = [case for result in report["testResults"] for case in result["assertionResults"]]
            if (report["success"] is not True or type(total) is not int or total <= 0
                    or report["numPassedTests"] != total or report["numPendingTests"] != 0 or report["numFailedTests"] != 0
                    or len(assertions) != total or any(case["status"] != "passed" for case in assertions)):
                return False
            if suite == "db" and sum(case["title"] == CASE for case in assertions) != 1:
                return False
        restarted = load("restart.json")
        cleaned = load("cleanup.json")
        before = {"Id": restarted["containerId"], "Image": restarted["imageId"], "DeclaredImage": restarted["imageRef"],
                  "Labels": restarted["labels"], "StartedAt": restarted["beforeStartedAt"], "Health": restarted["health"]}
        validate(before, container, labels, require_healthy=True)
        validate({**before, "StartedAt": restarted["afterStartedAt"]}, container, labels, require_healthy=True)
        return (restarted["status"] == "verified" and cleaned["status"] == "verified"
                and restarted["beforeStartedAt"] != restarted["afterStartedAt"]
                and re.fullmatch(r"16\.\d+", restarted["serverVersion"]) is not None and restarted["deadlineSeconds"] == 20
                and cleaned["fixtureDatabases"] == 0 and cleaned["containerId"] == container
                and cleaned["imageId"] == restarted["imageId"] and cleaned["labels"] == labels)
    except (OSError, ValueError, TypeError, KeyError, RestartError):
        return False


if __name__ == "__main__":
    try:
        context(os.environ)  # Retain the original fail-closed noarg guard before action selection.
        if len(sys.argv) == 2 and sys.argv[1] == "capture":
            result = capture_binding(Path(os.environ["DEPLOYLITE_PG_RECEIPT_DIR"]), os.environ["DEPLOYLITE_PG_CONTAINER_ID"])
        elif len(sys.argv) == 1:
            result = restart()
        else:
            raise RestartError("invalid_action")
        print(json.dumps(result))
    except RestartError as error:
        print(json.dumps({"status": "not_verified", "reason": str(error)}))
        sys.exit(1)
