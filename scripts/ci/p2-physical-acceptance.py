"""Owned hosted-job fixture preparation and strict P2 evidence verification.

Source approval/manifest generation is never runtime authorization. Publication
must separately authorize this exact job's operations/resources. Native effects
require explicit hosted execution identity, private config, and recorded ownership.
"""
import copy
import datetime
import secrets
import uuid
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
HEX = r"[a-f0-9]{64}"
DIGEST = r"sha256:" + HEX
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
REFERENCE = r"127\.0\.0\.1:49172/deploylite-p2/[a-z0-9/-]+@" + DIGEST


class PhysicalError(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise PhysicalError(reason)


def validate_context(grant, env, now_ms):
    require(isinstance(grant, dict), "invalid_grant")
    require(env.get("DEPLOYLITE_DOCKER_RUNTIME_GRANT") == grant.get("authorization") == "P2_PHYSICAL_DOCKER_APPROVED", "explicit_runtime_scope_required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted", "hosted_job_required")
    require(grant.get("engineScope") == "ephemeral-github-actions-job", "owned_engine_scope_required")
    job = grant.get("ciJob", {})
    for field, variable in {"repository": "GITHUB_REPOSITORY", "runId": "GITHUB_RUN_ID", "runAttempt": "GITHUB_RUN_ATTEMPT", "job": "GITHUB_JOB"}.items():
        require(isinstance(job.get(field), str) and bool(job[field]) and job[field] == env.get(variable), "job_identity_mismatch")
    require(job.get("job") == "p2-docker-acceptance", "wrong_job")
    require(grant.get("commit") == env.get("GITHUB_SHA") and re.fullmatch(r"[a-f0-9]{40}", grant.get("commit", "")), "commit_identity_mismatch")
    require(isinstance(grant.get("expiresAtMs"), (int, float)) and now_ms < grant["expiresAtMs"] <= now_ms + 7200000, "grant_expired")
    require(re.fullmatch(UUID, grant.get("runId", "")) and len(grant.get("grantId", "")) >= 16, "fresh_execution_identity_required")
    require(grant.get("engineOs") == "linux" and grant.get("engineArchitecture") in ("x86_64", "amd64") and grant.get("platform") == "linux/amd64", "native_platform_required")
    require(isinstance(grant.get("engineId"), str) and len(grant["engineId"]) >= 16, "engine_identity_required")
    require(re.fullmatch(r"unix:///[A-Za-z0-9/_.-]+", grant.get("dockerHost", "")) and grant["dockerHost"] == env.get("DOCKER_HOST"), "socket_identity_mismatch")
    require(not any(env.get(field) for field in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "ambient_context_forbidden")
    require(Path(grant.get("dockerConfigDirectory", "")).is_absolute() and grant["dockerConfigDirectory"] == env.get("DOCKER_CONFIG"), "private_config_binding_required")
    require(grant.get("bounds") == MANIFEST["resourceProposal"], "resource_scope_mismatch")
    require(set(grant.get("sourceHashes", {})) == set(MANIFEST["sourceFiles"]) and all(re.fullmatch(HEX, value) for value in grant["sourceHashes"].values()), "source_scope_mismatch")
    return copy.deepcopy(grant)


def validate_config(metadata, entries):
    require(metadata.get("directory") is True and metadata.get("symlink") is False and metadata.get("owned") is True and metadata.get("mode", 0) & 0o077 == 0, "private_owned_directory_required")
    require(entries == [], "empty_config_required")


def validate_sources(expected, current):
    return bool(expected) and expected == current and set(expected) == set(MANIFEST["sourceFiles"])


def manifest_reference(body, header, repository):
    require(isinstance(body, bytes) and header == "sha256:" + hashlib.sha256(body).hexdigest(), "observed_manifest_digest_mismatch")
    require(re.fullmatch(r"127\.0\.0\.1:49172/deploylite-p2/[a-z0-9/-]+", repository), "owned_repository_required")
    data = json.loads(body)
    require(data.get("schemaVersion") == 2, "unsupported_manifest")
    return repository + "@" + header


def validate_image(info, expected):
    require(re.fullmatch(DIGEST, info.get("id", "")), "image_config_identity_required")
    require(expected["reference"] in info.get("repoDigests", []) and re.fullmatch(REFERENCE, expected["reference"]), "observed_repo_digest_required")
    require(info.get("platform") == expected["platform"] == "linux/amd64" and info.get("user") == "65532:65532", "image_platform_or_user_mismatch")
    require(info.get("command") == ["/bin/busybox", "httpd", "-f", "-p", "8080", "-h", "/www"], "fixture_command_mismatch")
    require(info.get("healthIntervalNs") == info.get("healthTimeoutNs") == 1000000000 and info.get("healthPath") == "/healthz", "fixture_health_mismatch")
    require(info.get("flavor") == expected["flavor"] in ("a", "h"), "fixture_flavor_mismatch")
    return copy.deepcopy(info)


def validate_owned_resource(info, owned, limits):
    for field in ("id", "kind", "owner", "projectId", "imageId", "imageRef", "networkId"):
        require(info.get(field) == owned.get(field) and info.get(field) is not None, "resource_identity_mismatch")
    require(re.fullmatch(HEX, info["id"]) and re.fullmatch(DIGEST, info["imageId"]) and re.fullmatch(HEX, info["networkId"]), "physical_resource_id_required")
    registry = info["kind"] == "registry"
    require(info.get("cpuNano") == int(limits["registryCpu" if registry else "fixtureCpu"] * 1000000000), "owned_cpu_mismatch")
    require(info.get("memoryBytes") == limits["registryMemoryBytes" if registry else "fixtureMemoryBytes"] and info.get("pids") == 64, "owned_memory_or_pid_mismatch")
    require(info.get("hostIp") == "127.0.0.1" and info.get("hostPort") in ([49172] if registry else [49170, 49171]), "loopback_port_mismatch")
    require(info.get("readonly") is True and info.get("privileged") is False and info.get("binds") == [] and info.get("labelsVerified") is True, "unsafe_resource_configuration")
    return copy.deepcopy(info)


def preparation_plan(grant, manifest):
    context = manifest["fixture"]["context"]
    plan = [{"kind": "input-pull", "image": manifest["fixture"][field], "argv": ["docker", "pull", "--platform", "linux/amd64", manifest["fixture"][field]]} for field in ("base", "registry")]
    for flavor in ("a", "h"):
        repository = "127.0.0.1:49172/deploylite-p2/" + grant["runId"] + "-" + flavor
        plan.extend([
            {"kind": "build", "target": flavor, "context": context, "argv": ["docker", "build", "--pull=false", "--network=none", "--platform", "linux/amd64", "--target", flavor, "--tag", repository + ":prepared", context]},
            {"kind": "observe-manifest", "repository": repository, "reference": "observe header and bytes, never config image ID"},
            {"kind": "pull-derived", "repository": repository, "reference": "exact observed RepoDigest"},
        ])
    plan.append({"kind": "registry-removed-before-cases"})
    return plan


def allowed_command(argv, grant, closure):
    require(isinstance(argv, (list, tuple)) and argv and argv[0] == "docker" and all(isinstance(value, str) for value in argv), "argv_required")
    op = argv[1] if len(argv) > 1 else ""
    require(op not in ("system", "update", "context", "login", "logout", "volume"), "shared_daemon_operation_forbidden")
    if op in ("rm", "stop", "start") or (op == "network" and len(argv) > 2 and argv[2] == "rm"):
        target = argv[-1]
        owned = closure.get("ownedIds", []) if closure else grant.get("ownedIds", [])
        require(re.fullmatch(HEX, target) and target in owned, "exact_recorded_id_required")
        return
    if op == "pull":
        require(argv[-1] in (MANIFEST["fixture"]["base"], MANIFEST["fixture"]["registry"]) or re.fullmatch(REFERENCE, argv[-1]), "pinned_input_required")
    elif op == "build":
        require(argv[-1] == MANIFEST["fixture"]["context"] and "--network=none" in argv and "--pull=false" in argv and "--platform" in argv and argv[argv.index("--platform") + 1] == "linux/amd64", "owned_native_fixture_build_required")
    elif op in ("tag", "push"):
        require(re.fullmatch(r"127\.0\.0\.1:49172/deploylite-p2/" + re.escape(grant["runId"]) + r"-(a|h):prepared", argv[-1]), "owned_registry_tag_required")
    else:
        require(op in ("info", "inspect", "image", "container", "ps", "network", "run"), "unsupported_fixture_operation")


def run_effect(argv, grant, boundary, closure=None, max_seconds=None):
    require(boundary is not None, "explicit_process_boundary_required")
    now = boundary.now
    if closure:
        require(closure.get("kind") == "cleanup", "postexpiry_recovery_unbound")
        require(grant.get("expiryClosures", {}).get("cleanupMaxMs") == 30000, "explicit_cleanup_permission_required")
        deadline = closure.get("deadline", 0)
        require(now < deadline <= now + 30 and bool(closure.get("ownedIds")), "cleanup_deadline_or_scope_invalid")
        require(closure.setdefault("originalDeadline", deadline) == deadline, "cleanup_deadline_cannot_renew")
        budget = deadline - now
    else:
        wall_ms = getattr(boundary, "wall_ms", now * 1000)
        require(wall_ms < grant["expiresAtMs"], "fresh_effect_after_expiry")
        budget = min(120, (grant["expiresAtMs"] - wall_ms) / 1000)
    if max_seconds is not None:
        require(max_seconds > 0, "phase_deadline_exhausted")
        budget = min(budget, max_seconds)
    allowed_command(argv, grant, closure)
    actual = ["docker", "--config", grant["dockerConfigDirectory"], "--host", grant["dockerHost"], *argv[1:]]
    try:
        result = boundary.run(actual, timeout=budget)
    except (OSError, subprocess.SubprocessError):
        raise PhysicalError("owned_process_outcome_unknown") from None
    require(boundary.now - now < budget and result.get("returncode") == 0, "owned_process_outcome_unknown")
    return result


def cleanup_owned(owned, boundary, deadline):
    receipts = []
    for resource in reversed(owned):
        require(boundary.now < deadline, "cleanup_deadline_exhausted")
        observed = boundary.inspect(resource["id"], timeout=min(3, deadline - boundary.now))
        validate_owned_resource(observed, resource, MANIFEST["resourceProposal"])
        boundary.remove(resource["id"], resource["kind"], timeout=min(3, deadline - boundary.now))
        require(boundary.now < deadline, "cleanup_outcome_unknown")
        receipts.append({"id": resource["id"], "verifiedLabels": True, "removed": True})
    return receipts


def verify_report(report, titles):
    try:
        cases = [case for result in report["testResults"] for case in result["assertionResults"]]
        names = [case["fullName"] for case in cases]
        return (report["success"] is True and report["numTotalTests"] == report["numPassedTests"] == len(titles)
                and report["numPendingTests"] == report["numFailedTests"] == 0 and len(names) == len(set(names)) == len(titles)
                and set(names) == set(titles) and all(case["status"] == "passed" for case in cases))
    except (KeyError, TypeError):
        return False


def verify_physical(receipts, grant):
    try:
        expected = {case["receiptFile"] for case in MANIFEST["suites"]["docker"]["physicalCases"]}
        require(len(receipts) == len(expected) and {value["receiptFile"] for value in receipts} == expected, "exact_physical_cases_required")
        for receipt in receipts:
            require(receipt["status"] == "PASS" and receipt["physicalDocker"] is True and receipt["postgres"] is False and receipt["grantId"] == grant["grantId"] and receipt["owner"] == grant["owner"], "physical_receipt_binding_mismatch")
            events = receipt["events"]
            require(any(e["kind"] == "owned-engine-observation" and e["engineId"] == grant["engineId"] and e["ciJob"] == grant["ciJob"] for e in events), "engine_job_not_observed")
            require(any(e["kind"] == "docker-command" and e.get("physicalRan") is True and e.get("phase") == "completed" and e.get("exitCode") == 0 for e in events), "physical_process_not_observed")
            require(not any(e["kind"] == "cleanup-blocked" for e in events), "cleanup_unknown")
            cleaned = {e["id"] for e in events if e["kind"] == "cleanup-receipt" and e.get("verifiedLabels") is True and e.get("removed") is True}
            require(all(resource["id"] in cleaned and resource["owner"] == receipt["owner"] and resource["project"] == receipt["projectId"] for resource in receipt["resources"]), "owned_cleanup_incomplete")
            tamper = receipt["receiptFile"].startswith("WIRE_")
            if tamper:
                injected = next(e for e in events if e["kind"] == "harness-injected-wire-tamper")
                reason = "agent authentication failed" if injected["tamper"] == "unsigned" else "INITIAL immutable execution binding changed"
                require(any(e["kind"] == "receiver-rejection" and all(e[k] == injected[k] for k in ("commandId", "deploymentId", "correlationId")) and e["reason"] == reason and e["requestAuthenticated"] is (injected["tamper"] != "unsigned") for e in events), "correlated_wire_rejection_required")
                require(any(e["kind"] == "api-response" and e.get("statusCode") == 502 and e["body"]["error"].get("code") == "DEPLOY_DISPATCH_FAILED" and e["body"]["error"].get("correlationId") == injected["correlationId"] for e in events), "correlated_api_rejection_required")
            else:
                proof = next(e["body"]["data"]["deployment"]["executionReceipt"] for e in events if e["kind"] == "api-response" and e.get("action") == "INITIAL" and e.get("statusCode") == 200)
                require(proof["projectId"] == receipt["projectId"] and proof["hostPort"] == 49170 and proof["containerPort"] == 8080 and re.fullmatch(HEX, proof["containerId"]) and re.fullmatch(DIGEST, proof["effectiveImageDigest"]), "trusted_proof_required")
                require(any(e["kind"] == "physical-observation" and e["observation"]["id"] == proof["containerId"] and e["observation"]["owner"] == receipt["owner"] and e["observation"]["projectId"] == receipt["projectId"] for e in events), "observed_proof_identity_required")
                require(any(e["kind"] == "owned-container-budget" and e["containerId"] == proof["containerId"] and e["cpu"] == 500000000 and e["memory"] == 67108864 and e["pids"] == 64 for e in events), "observed_caps_required")
        return True
    except (PhysicalError, KeyError, TypeError, StopIteration):
        return False


class NativeBoundary:
    """Explicit runner; no process is constructed by imports or pure guards."""
    @property
    def now(self):
        return time.monotonic()

    @property
    def wall_ms(self):
        return time.time() * 1000

    def run(self, argv, timeout):
        safe_env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL")}
        result = subprocess.run(argv, cwd=ROOT, env=safe_env, check=False, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700)
    stat = path.lstat()
    require(path.is_dir() and not path.is_symlink() and stat.st_uid == os.getuid() and stat.st_mode & 0o077 == 0, "private_owned_directory_required")


def write_private(path, value, exclusive=True):
    if not exclusive:
        load_private(path)  # Refuse replaced, public or non-owned evidence before overwrite.
    flags = os.O_WRONLY | os.O_NOFOLLOW | (os.O_CREAT | os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def load_private(path, require_private=True):
    stat = path.lstat()
    require(path.is_file() and not path.is_symlink() and stat.st_uid == os.getuid() and (not require_private or stat.st_mode & 0o077 == 0), "private_owned_file_required")
    return json.loads(path.read_text())


def current_sources():
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in MANIFEST["sourceFiles"]}


def inspect_json(argv, grant, boundary, closure=None, deadline=None):
    try:
        value = json.loads(run_effect(argv, grant, boundary, closure, max_seconds=None if deadline is None else deadline - boundary.now)["stdout"])
        require(deadline is None or boundary.now < deadline, "preparation_inspection_outcome_unknown")
        return value
    except (ValueError, TypeError):
        raise PhysicalError("selected_inspection_invalid") from None


ENGINE_FORMAT = '{"id":{{json .ID}},"os":{{json .OSType}},"architecture":{{json .Architecture}}}'
IMAGE_FORMAT = ('{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
                '"user":{{json .Config.User}},"command":{{json .Config.Cmd}},"health":{{json .Config.Healthcheck}}}')
CONTAINER_FORMAT = ('{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},'
                    '"owner":{{json (index .Config.Labels "com.deploylite.owner")}},'
                    '"projectId":{{json (index .Config.Labels "com.deploylite.project")}},'
                    '"cpuNano":{{json .HostConfig.NanoCpus}},"memoryBytes":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}},'
                    '"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},'
                    '"binds":{{json .HostConfig.Binds}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}')
NETWORK_FORMAT = ('{"id":{{json .Id}},"name":{{json .Name}},'
                  '"owner":{{json (index .Labels "com.deploylite.owner")}},"projectId":{{json (index .Labels "com.deploylite.project")}},'
                  '"containers":{{json .Containers}}}')


class Coordinator:
    def __init__(self, grant, journal, root, boundary, preparation_deadline=None):
        self.grant, self.journal, self.root, self.boundary = grant, journal, root, boundary
        self.started = boundary.now
        self.preparation_deadline = self.started + MANIFEST["resourceProposal"]["prepMaxSeconds"] if preparation_deadline is None else preparation_deadline

    def save(self):
        write_private(self.root / "preparation.json", self.journal, exclusive=not (self.root / "preparation.json").exists())

    def command(self, argv, closure=None):
        require(validate_sources(self.grant["sourceHashes"], current_sources()), "source_changed_before_effect")
        if closure is None:
            require(self.boundary.now < self.preparation_deadline, "preparation_deadline_exhausted")
        self.journal["events"].append({"phase": "intent", "argv": argv, "time": self.boundary.now})
        self.save()
        try:
            phase_budget = None if closure else self.preparation_deadline - self.boundary.now
            result = run_effect(argv, self.grant, self.boundary, closure, max_seconds=phase_budget)
            self.journal["events"].append({"phase": "completed", "argv": argv, "time": self.boundary.now})
            self.save()
            return result["stdout"].strip()
        except PhysicalError:
            self.journal["status"] = "UNKNOWN"
            self.save()
            raise

    def record(self, resource):
        self.journal["resources"].append(resource)
        self.grant.setdefault("ownedIds", []).append(resource["id"])
        self.save()  # Persist exact ID before any subsequent validation/removal.

    def container(self, resource, closure=None):
        info = inspect_json(["docker", "container", "inspect", "--format", CONTAINER_FORMAT, resource["id"]], self.grant, self.boundary, closure, deadline=None if closure else self.preparation_deadline)
        ports = info.pop("ports"); networks = info.pop("networks")
        selected = ports[str(resource["containerPort"]) + "/tcp"]
        require(len(selected) == 1 and len(networks) == 1, "single_owned_binding_required")
        info.update(kind=resource["kind"], hostIp=selected[0]["HostIp"], hostPort=int(selected[0]["HostPort"]),
                    networkId=next(iter(networks.values()))["NetworkID"], labelsVerified=info.get("owner") == resource["owner"] and info.get("projectId") == resource["projectId"])
        info["binds"] = info["binds"] or []
        return validate_owned_resource(info, resource, self.grant["bounds"])

    def remove(self, resource, closure):
        require(self.boundary.now < closure["deadline"], "cleanup_deadline_exhausted")
        if resource["kind"] == "network":
            info = inspect_json(["docker", "network", "inspect", "--format", NETWORK_FORMAT, resource["id"]], self.grant, self.boundary, closure)
            require(all(info[key] == resource[key] for key in ("id", "name", "owner", "projectId")) and not info["containers"], "owned_empty_network_required")
            self.command(["docker", "network", "rm", resource["id"]], closure)
        else:
            self.container(resource, closure)
            self.command(["docker", "rm", "--force", resource["id"]], closure)
        resource["removed"] = True
        self.save()

    def cleanup(self):
        # Capture once in durable evidence. Every later cleanup command gets only the remaining portion.
        closure = self.journal.get("cleanupClosure")
        if closure is None:
            closure = {"kind": "cleanup", "deadline": self.boundary.now + 30, "originalDeadline": self.boundary.now + 30,
                       "ownedIds": [r["id"] for r in self.journal["resources"]]}
            closure["originalDeadline"] = closure["deadline"]
            self.journal["cleanupClosure"] = closure
            self.save()
        try:
            engine = inspect_json(["docker", "info", "--format", ENGINE_FORMAT], self.grant, self.boundary, closure)
            require(engine["id"] == self.grant["engineId"] and engine["os"] == "linux", "cleanup_engine_identity_changed")
            for resource in reversed(self.journal["resources"]):
                if not resource.get("removed"):
                    self.remove(resource, closure)
            require(self.boundary.now < closure["deadline"], "cleanup_outcome_unknown")
            require(not any(e.get("phase") == "intent" and not any(later.get("phase") == "completed" and later.get("argv") == e["argv"] for later in self.journal["events"][index + 1:]) for index, e in enumerate(self.journal["events"])), "creation_outcome_unknown")
            self.journal["cleanupStatus"] = "verified"
        except PhysicalError:
            self.journal["cleanupStatus"] = "UNKNOWN"
            raise
        finally:
            self.save()

    def start_container(self, kind, image_ref, image_id, network, port):
        active = [r for r in self.journal["resources"] if r["kind"] != "network" and not r.get("removed")]
        require(len(active) < 2, "preparation_container_ceiling")
        cpu, memory = (0.5, 268435456) if kind == "registry" else (0.5, 67108864)
        container_port = 5000 if kind == "registry" else 8080
        name = "p2v-" + self.grant["runId"] + "-" + kind
        argv = ["docker", "run", "--detach", "--pull=never", "--name", name, "--cpus=" + str(cpu), "--memory=" + str(memory), "--pids-limit=64",
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", "--network", network["name"],
                "--label", "com.deploylite.owner=" + self.grant["owner"], "--label", "com.deploylite.project=" + self.grant["projectId"],
                "--publish", "127.0.0.1:" + str(port) + ":" + str(container_port), "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m"]
        if kind == "registry":
            argv.extend(["--tmpfs", "/var/lib/registry:rw,nosuid,size=256m"])
        argv.append(image_ref)
        resource = {"kind": kind, "name": name, "id": self.command(argv), "imageId": image_id, "imageRef": image_ref,
                    "owner": self.grant["owner"], "projectId": self.grant["projectId"], "networkId": network["id"], "containerPort": container_port}
        require(re.fullmatch(HEX, resource["id"]), "physical_container_id_required")
        self.record(resource)
        self.container(resource)
        return resource


def loopback_bytes(url, maximum, deadline, clock=time.monotonic):
    """Nonblocking selected loopback HTTP with one deadline, including headers/body.

    A timed-out read stays unknown. No worker thread, second period or assertion of
    absence is used; an already delivered OS operation cannot be undone by this reader.
    """
    import errno
    import select
    import socket
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    require(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port in (49172, 49171)
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
            and re.fullmatch(r"/[A-Za-z0-9/_.:-]*", parsed.path), "owned_loopback_endpoint_required")
    require(type(maximum) is int and 0 < maximum <= 1048576, "bounded_response_size_required")
    sock = None

    def remaining():
        budget = deadline - clock()
        require(budget > 0, "loopback_deadline_exhausted")
        return budget

    def ready(write=False):
        reads, writes, errors = select.select([] if write else [sock], [sock] if write else [], [sock], remaining())
        remaining()  # A delayed settlement never becomes a successful response.
        require(not errors and bool(writes if write else reads), "loopback_settlement_unknown")

    try:
        remaining()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setblocking(False)
        status = sock.connect_ex(("127.0.0.1", parsed.port))
        require(status in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY), "loopback_connection_unknown")
        if status != 0:
            ready(write=True)
            require(sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0, "loopback_connection_unknown")
        request = ("GET " + parsed.path + " HTTP/1.0\r\nHost: 127.0.0.1:" + str(parsed.port) + "\r\n"
                   "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json\r\n"
                   "Connection: close\r\n\r\n").encode("ascii")
        offset = 0
        while offset < len(request):
            ready(write=True)
            try: sent = sock.send(request[offset:])
            except BlockingIOError: continue
            require(sent > 0, "loopback_request_unknown")
            offset += sent
        data, body, headers, content_length = bytearray(), bytearray(), None, None
        while True:
            ready()
            try: part = sock.recv(4096)
            except BlockingIOError: continue
            remaining()
            if not part:
                require(headers is not None and (content_length is None or len(body) == content_length), "incomplete_loopback_response")
                return bytes(body), headers.get("docker-content-digest")
            if headers is None:
                data.extend(part)
                separator = data.find(b"\r\n\r\n")
                require(separator <= 16384 and (separator >= 0 or len(data) <= 16384), "bounded_http_headers_required")
                if separator < 0: continue
                head, initial_body = bytes(data[:separator]), bytes(data[separator + 4:])
                lines = head.decode("ascii").split("\r\n")
                require(lines[0] in ("HTTP/1.0 200 OK", "HTTP/1.1 200 OK"), "owned_http_200_required")
                headers = {}
                for line in lines[1:]:
                    key, colon, value = line.partition(":")
                    key = key.lower()
                    require(colon and key not in headers, "unambiguous_http_headers_required")
                    headers[key] = value.strip()
                require(not headers.get("transfer-encoding") and headers.get("content-encoding", "identity") == "identity", "unsupported_http_encoding")
                if "content-length" in headers:
                    require(re.fullmatch(r"[0-9]+", headers["content-length"]), "valid_http_length_required")
                    content_length = int(headers["content-length"])
                    require(content_length <= maximum, "bounded_response_size_required")
                body.extend(initial_body)
            else:
                body.extend(part)
            require(len(body) <= maximum and (content_length is None or len(body) <= content_length), "bounded_response_size_required")
            if content_length is not None and len(body) == content_length:
                remaining()
                return bytes(body), headers.get("docker-content-digest")
    except (OSError, ValueError, UnicodeError):
        raise PhysicalError("owned_loopback_outcome_unknown") from None
    finally:
        if sock is not None: sock.close()


def wait_loopback(url, deadline, expected=None):
    while time.monotonic() < deadline:
        try:
            body, header = loopback_bytes(url, 1048576, deadline)
            if expected is not None:
                require(body.decode().strip() == expected, "fixture_version_mismatch")
            return body, header
        except (OSError, PhysicalError):
            if time.monotonic() >= deadline:
                break
            time.sleep(min(0.1, deadline - time.monotonic()))
    raise PhysicalError("owned_loopback_readiness_unverified")


def validate_native_inputs(env):
    """Gate before constructing a process; only the explicitly approved future job enters."""
    require(env.get("DEPLOYLITE_DOCKER_RUNTIME_GRANT") == "P2_PHYSICAL_DOCKER_APPROVED", "explicit_runtime_scope_required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted" and env.get("GITHUB_JOB") == "p2-docker-acceptance", "hosted_job_required")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", env.get("GITHUB_REPOSITORY", "")), "source_job_binding_required")
    require(all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")), "run_identity_required")
    require(env.get("DOCKER_HOST") == "unix:///var/run/docker.sock" and not any(env.get(k) for k in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "native_socket_required")
    require(not env.get("DATABASE_URL") and env.get("DEPLOYLITE_DB_INTEGRATION") != "1" and env.get("DEPLOYLITE_API_DB_INTEGRATION") != "1", "postgres_scope_forbidden")
    root = Path(env.get("RUNNER_TEMP", ""))
    require(root.is_absolute() and root.is_dir() and not root.is_symlink() and root.lstat().st_uid == os.getuid(), "owned_runner_temp_required")
    return root


def preparation_root(env, create=False):
    runner = validate_native_inputs(env)
    root = Path(env.get("DEPLOYLITE_DOCKER_PREPARATION_ROOT", ""))
    require(root == runner / "deploylite-p2-docker-evidence", "exact_evidence_root_required")
    private_directory(root, create)
    return root


def inspect_config(env):
    config = Path(env.get("DOCKER_CONFIG", ""))
    require(config == Path(env["RUNNER_TEMP"]) / "deploylite-p2-empty-docker-config", "exact_private_config_required")
    stat = config.lstat()
    validate_config({"directory": config.is_dir(), "symlink": config.is_symlink(), "owned": stat.st_uid == os.getuid(), "mode": stat.st_mode}, list(config.iterdir()))


def harness_contract():
    source = (ROOT / "apps/api/src/deployment-docker.integration.test.ts").read_text()
    require(hashlib.sha256(source.encode()).hexdigest() == MANIFEST["preparedFrom"]["dockerFrozenSha256"], "reviewed_harness_changed_reconciliation_required")
    def strings(name):
        selected = re.search(r"const " + name + r" = \[(.*?)\] as const;", source, re.S)
        require(selected is not None, "reviewed_harness_contract_missing")
        return re.findall(r'"([^"\n]+)"', selected.group(1))
    return strings("sourcePaths"), strings("operations")


def normalized_digest_reference(reference):
    require(isinstance(reference, str) and reference.count("@") == 1, "digest_reference_required")
    name, digest = reference.split("@")
    require(re.fullmatch(DIGEST, digest) and re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*", name), "exact_digest_repository_required")
    parent, separator, leaf = name.rpartition("/")
    leaf = leaf.split(":", 1)[0]  # A tag does not form part of RepoDigest identity.
    name = (parent + separator + leaf) if separator else leaf
    components = name.split("/")
    if len(components) == 1 or not ("." in components[0] or ":" in components[0] or components[0] == "localhost"):
        components.insert(0, "docker.io")
    if components[0] == "index.docker.io": components[0] = "docker.io"
    if components[0] == "docker.io" and len(components) == 2: components.insert(1, "library")
    require(all(components), "nonempty_repository_required")
    return "/".join(components), digest


def validate_input_image(info, reference, platform):
    expected = normalized_digest_reference(reference)
    observed = [normalized_digest_reference(value) for value in info["repoDigests"]]
    require(expected in observed and info["os"] + "/" + info["architecture"] == platform, "observed_registry_pin_required")
    return info


def observe_image(reference, grant, boundary, deadline=None):
    data = inspect_json(["docker", "image", "inspect", "--format", IMAGE_FORMAT, reference], grant, boundary, deadline=deadline)
    health = data.pop("health")
    data.update(platform=data.pop("os") + "/" + data.pop("architecture"), healthIntervalNs=health["Interval"], healthTimeoutNs=health["Timeout"])
    require(health["Test"] == ["CMD", "/bin/busybox", "wget", "-q", "-T", "1", "-Y", "off", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"], "actual_fixture_health_command_mismatch")
    data["healthPath"] = "/healthz"
    return data


def prepare(env):
    runner = validate_native_inputs(env)
    root = preparation_root(env, create=True)
    config = Path(env.get("DOCKER_CONFIG", ""))
    require(config == runner / "deploylite-p2-empty-docker-config", "exact_private_config_required")
    private_directory(config, create=True)
    inspect_config(env)
    hashes = current_sources()
    sources, operations = harness_contract()
    context_files = sorted(str(path.relative_to(ROOT)) for path in (ROOT / MANIFEST["fixture"]["context"]).rglob("*") if path.is_file())
    require(context_files == sorted(MANIFEST["fixture"]["files"]) and not any((ROOT / path).is_symlink() for path in context_files), "exact_fixture_context_required")
    # Engine identity is an actual selected read after all input gates, never an invented image/container digest.
    boundary = NativeBoundary()
    preparation_deadline = boundary.now + MANIFEST["resourceProposal"]["prepMaxSeconds"]
    selected = ["docker", "--config", str(config), "--host", env["DOCKER_HOST"], "info", "--format", ENGINE_FORMAT]
    engine_result = boundary.run(selected, timeout=min(3, preparation_deadline - boundary.now))
    require(engine_result["returncode"] == 0 and boundary.now < preparation_deadline, "native_engine_observation_unknown")
    engine = json.loads(engine_result["stdout"])
    run_id = str(uuid.uuid4())
    grant = {"authorization": env["DEPLOYLITE_DOCKER_RUNTIME_GRANT"], "grantId": "p2v-" + secrets.token_hex(24), "runId": run_id,
             "engineScope": "ephemeral-github-actions-job", "ciJob": {field: env[key] for field, key in {"repository": "GITHUB_REPOSITORY", "runId": "GITHUB_RUN_ID", "runAttempt": "GITHUB_RUN_ATTEMPT", "job": "GITHUB_JOB"}.items()},
             "commit": env["GITHUB_SHA"], "expiresAtMs": boundary.wall_ms + 1200000, "dockerHost": env["DOCKER_HOST"], "dockerConfigDirectory": str(config),
             "engineId": engine["id"], "engineOs": engine["os"], "engineArchitecture": engine["architecture"], "platform": "linux/amd64",
             "owner": "p2v-" + run_id, "projectId": str(uuid.uuid4()), "bounds": MANIFEST["resourceProposal"], "expiryClosures": {"cleanupMaxMs": 30000}, "sourceHashes": hashes}
    validate_context(grant, env, boundary.wall_ms)
    write_private(root / "job-grant.json", grant)
    journal = {"schemaVersion": 1, "status": "RUNNING", "grantId": grant["grantId"], "ciJob": grant["ciJob"], "engineId": grant["engineId"],
               "sourceHashes": hashes, "startedAtMs": boundary.wall_ms, "events": [], "resources": [], "derivedImages": {}}
    coordinator = Coordinator(grant, journal, root, boundary, preparation_deadline)
    try:
        for ref in (MANIFEST["fixture"]["base"], MANIFEST["fixture"]["registry"]):
            coordinator.command(["docker", "pull", "--platform", "linux/amd64", ref])
        registry = inspect_json(["docker", "image", "inspect", "--format", IMAGE_FORMAT, MANIFEST["fixture"]["registry"]], grant, boundary, deadline=coordinator.preparation_deadline)
        validate_input_image(registry, MANIFEST["fixture"]["registry"], "linux/amd64")
        network = {"kind": "network", "name": "p2v-prep-" + run_id, "owner": grant["owner"], "projectId": grant["projectId"]}
        network["id"] = coordinator.command(["docker", "network", "create", "--internal", "--label", "com.deploylite.owner=" + grant["owner"], "--label", "com.deploylite.project=" + grant["projectId"], network["name"]])
        require(re.fullmatch(HEX, network["id"]), "physical_network_id_required")
        coordinator.record(network)
        coordinator.start_container("registry", MANIFEST["fixture"]["registry"], registry["id"], network, 49172)
        wait_loopback("http://127.0.0.1:49172/v2/", min(boundary.now + 15, coordinator.preparation_deadline))
        for flavor in ("a", "h"):
            repository = "127.0.0.1:49172/deploylite-p2/" + run_id + "-" + flavor
            coordinator.command(["docker", "build", "--pull=false", "--network=none", "--platform", "linux/amd64", "--target", flavor, "--tag", repository + ":prepared", MANIFEST["fixture"]["context"]])
            coordinator.command(["docker", "push", repository + ":prepared"])
            body, header = loopback_bytes("http://127.0.0.1:49172/v2/deploylite-p2/" + run_id + "-" + flavor + "/manifests/prepared", 1048576, min(boundary.now + 3, coordinator.preparation_deadline))
            reference = manifest_reference(body, header, repository)
            coordinator.command(["docker", "pull", "--platform", "linux/amd64", reference])
            image = observe_image(reference, grant, boundary, deadline=coordinator.preparation_deadline)
            smoke = coordinator.start_container("smoke", reference, image["id"], network, 49171)
            expected = (ROOT / MANIFEST["fixture"]["context"] / flavor / "version").read_text().strip()
            actual, _ = wait_loopback("http://127.0.0.1:49171/version", min(boundary.now + 15, coordinator.preparation_deadline), expected)
            image["flavor"] = flavor if actual.decode().strip() == expected else None
            validate_image(image, {"reference": reference, "flavor": flavor, "platform": "linux/amd64"})
            journal["derivedImages"][flavor] = {"reference": reference, "observed": image, "manifestBodySha256": hashlib.sha256(body).hexdigest(), "manifestHeader": header}
            # This is a fresh in-window removal, not a renewed post-expiry cleanup period.
            coordinator.container(smoke)
            coordinator.command(["docker", "rm", "--force", smoke["id"]])
            smoke["removed"] = True
            coordinator.save()
        coordinator.cleanup()  # Registry/network removed before any physical case starts.
        require(journal["cleanupStatus"] == "verified", "preparation_cleanup_unverified")
        private = runner / "deploylite-p2-private-inputs"
        private_directory(private, create=True)
        credentials = private / "credentials.json"
        write_private(credentials, {"trustKey": secrets.token_hex(32), "adminPassword": secrets.token_hex(32)})
        harness = {"schemaVersion": 1, "authorization": grant["authorization"], "grantId": grant["grantId"], "runId": run_id,
                   "expiresAt": datetime.datetime.fromtimestamp(grant["expiresAtMs"] / 1000, datetime.timezone.utc).isoformat(),
                   "dockerHost": grant["dockerHost"], "engineId": grant["engineId"], "image": journal["derivedImages"]["a"]["reference"], "platform": "linux/amd64",
                   "runtimeHost": str(uuid.uuid4()), "engineScope": grant["engineScope"], "ciJob": grant["ciJob"], "dockerConfigDirectory": str(config),
                   "activePort": 49170, "temporaryPort": 49171, "containerPort": 8080, "maxContainers": 3, "containerCpu": 0.5,
                   "containerMemoryBytes": 67108864, "healthPath": "/healthz", "credentialsFile": str(credentials), "receiptDirectory": str(root / "cases"),
                   "harnessSha256": MANIFEST["preparedFrom"]["dockerFrozenSha256"], "operations": operations,
                   "sourceHashes": {path: hashes[path] for path in sources}, "expiryClosures": {"cleanupMaxMs": 30000, "recoveryMaxMs": 60000}}
        write_private(private / "manifest.json", harness)
        # Paths/IDs only: secret material stays outside the uploaded evidence directory.
        output = {"DEPLOYLITE_DOCKER_MANIFEST": str(private / "manifest.json"), "DEPLOYLITE_DOCKER_GRANT_ID": grant["grantId"],
                  "DOCKER_CONFIG": str(config), "DOCKER_HOST": grant["dockerHost"], "DEPLOYLITE_DOCKER_PREPARATION_ROOT": str(root)}
        require(all("\n" not in value and "\r" not in value for value in output.values()), "unsafe_environment_path")
        (root / "environment.env").write_text("".join(key + "=" + value + "\n" for key, value in output.items()))
        journal.update(status="PREPARED", finishedAtMs=boundary.wall_ms, harnessManifest={key: value for key, value in harness.items() if key != "credentialsFile"})
        coordinator.save()
        return {"status": "PREPARED", "grantId": grant["grantId"], "runtimeAcceptance": "NOT YET VERIFIED"}
    except BaseException:
        journal["status"] = "UNKNOWN"
        coordinator.save()
        # No second grace period: this uses the same durable cleanup closure if already begun.
        coordinator.cleanup()
        raise


def cleanup(env):
    root = preparation_root(env)
    inspect_config(env)
    grant = load_private(root / "job-grant.json")
    require(grant["ciJob"] == {field: env[key] for field, key in {"repository": "GITHUB_REPOSITORY", "runId": "GITHUB_RUN_ID", "runAttempt": "GITHUB_RUN_ATTEMPT", "job": "GITHUB_JOB"}.items()} and grant["commit"] == env["GITHUB_SHA"], "same_job_required")
    journal = load_private(root / "preparation.json")
    require(journal["sourceHashes"] == current_sources() and journal["grantId"] == grant["grantId"], "fresh_source_binding_required")
    if journal.get("cleanupStatus") != "verified":
        # Exact preparation IDs only. Physical cases retain their original harness closure;
        # this job never extends or replaces it with another removal/recovery deadline.
        grant["ownedIds"] = [resource["id"] for resource in journal["resources"]]
        Coordinator(grant, journal, root, NativeBoundary()).cleanup()
    return {"status": "verified", "scope": "exact preparation resources only; case cleanup required by final verifier"}


def verify(env):
    root = preparation_root(env)
    grant = load_private(root / "job-grant.json")
    journal = load_private(root / "preparation.json")
    require(journal["status"] == "PREPARED" and journal["cleanupStatus"] == "verified" and journal["sourceHashes"] == current_sources(), "prepared_current_source_required")
    require(grant["ciJob"] == {field: env[key] for field, key in {"repository": "GITHUB_REPOSITORY", "runId": "GITHUB_RUN_ID", "runAttempt": "GITHUB_RUN_ATTEMPT", "job": "GITHUB_JOB"}.items()} and grant["commit"] == env["GITHUB_SHA"] and grant["engineId"] == journal["engineId"], "same_job_engine_required")
    report_path = root / "docker.json"
    report = load_private(report_path, require_private=False)  # Vitest reports are value-free in an owned private parent.
    titles = MANIFEST["suites"]["docker"]["guardTitles"] + MANIFEST["suites"]["docker"]["physicalTitles"]
    require(verify_report(report, titles), "exact_73_executed_titles_required")
    require(journal["finishedAtMs"] <= report["startTime"] <= time.time() * 1000 <= grant["expiresAtMs"] + 600000 and
            all(journal["finishedAtMs"] <= value["startTime"] <= value["endTime"] <= grant["expiresAtMs"] + 30000 for value in report["testResults"]), "fresh_execution_report_required")
    receipts = []
    for case in MANIFEST["suites"]["docker"]["physicalCases"]:
        receipt = load_private(root / "cases" / case["receiptFile"])
        receipt["receiptFile"] = case["receiptFile"]
        receipts.append(receipt)
    require(verify_physical(receipts, grant), "physical_owned_case_evidence_required")
    evidence = {"status": "verified", "ciJob": grant["ciJob"], "commit": grant["commit"], "engineId": grant["engineId"],
                "sourceHashes": journal["sourceHashes"], "reportSha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
                "receiptHashes": {case["receiptFile"]: hashlib.sha256((root / "cases" / case["receiptFile"]).read_bytes()).hexdigest() for case in MANIFEST["suites"]["docker"]["physicalCases"]},
                "actualRepoDigests": {flavor: value["reference"] for flavor, value in journal["derivedImages"].items()}}
    write_private(root / "verified.json", evidence)
    return {"status": "verified", "physicalCases": 8, "mockGuards": 65}
