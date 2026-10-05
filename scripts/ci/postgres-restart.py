"""Restart only the explicitly identified hosted-CI PostgreSQL service."""
import json
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
