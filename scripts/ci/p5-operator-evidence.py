"""Public operator proof only; validation never executes native engines or SQL."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
spec = importlib.util.spec_from_file_location("admission", Path(__file__).with_name("p5-operator-admission.py"))
admission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admission)
native = admission.native

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

def exact(value, keys, reason):
    native.require(isinstance(value, dict) and set(value) == set(keys), reason)

def validate_result(result, profile):
    exact(result, {"receipt", "uid", "original", "nativeStop", "nativeStart", "internalConnection", "authenticatedProbe", "restart", "persistence", "cleanup", "operator"}, "public_operator_result_required")
    native.require(type(result["uid"]) is int and 0 < result["uid"] <= 4294967294
        and all(result[key] == "passed" for key in ("authenticatedProbe", "restart", "persistence"))
        and result["cleanup"] == "verified", "executed_operator_persistence_cleanup_required")
    ready = result["receipt"]
    shared = {"schemaVersion", "projectId", "databaseId", "engine", "agentId", "planDigest", "environmentFingerprint", "containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"}
    exact(ready, shared | {"action", "commandId", "inputDigest", "correlationId", "observedAt", "status", "health", "storage", "idempotent", "redacted"}, "public_ready_receipt_required")
    native.require(ready["schemaVersion"] == 1 and ready["engine"] == profile["engine"] and ready["action"] == "database.runtime"
        and ready["status"] == "ready" and ready["health"] == "passed" and ready["storage"] == "verified"
        and ready["redacted"] is True and type(ready["idempotent"]) is bool
        and type(ready["observedAt"]) is int and ready["observedAt"] > 0, "ready_operator_receipt_required")
    for key in ("projectId", "agentId", "commandId"):
        native.require(isinstance(ready[key], str) and re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", ready[key]), "original_operator_uuid_required")
    native.require(isinstance(ready["databaseId"], str) and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", ready["databaseId"])
        and isinstance(ready["correlationId"], str) and 1 <= len(ready["correlationId"]) <= 128, "original_operator_public_scope_required")
    for key, pattern in (("containerId", r"[a-f0-9]{64}"), ("imageId", r"sha256:[a-f0-9]{64}"),
            ("inputDigest", r"[a-f0-9]{64}"), ("planDigest", r"[a-f0-9]{64}"), ("environmentFingerprint", r"[a-f0-9]{32}")):
        native.require(isinstance(ready[key], str) and re.fullmatch(pattern, ready[key]), "original_operator_identity_required")
    prefix = "dl-" + hashlib.sha256(ready["projectId"].encode()).hexdigest()[:32]
    native.require(ready["volumeName"] == prefix + "-vol-db-" + ready["databaseId"]
        and ready["networkName"] == prefix + "-net-db-" + ready["databaseId"], "original_operator_resource_names_required")
    exact(result["original"], {"projectId", "databaseId", "commandId", "planDigest", "volume", "network"}, "public_original_resources_required")
    exact(result["original"]["volume"], {"name", "createdAt"}, "public_original_volume_required")
    exact(result["original"]["network"], {"name", "id"}, "public_original_network_required")
    native.validate_resource_receipt(result)
    native.validate_internal_connection(result, profile)
    exact(result["nativeStop"], {"receipt", "originalReplayFingerprint"}, "public_operator_stop_required")
    stopped = result["nativeStop"]["receipt"]
    exact(stopped, shared | {"action", "commandId", "originalCommandId", "profileId", "inputDigest", "correlationId", "observedAt", "status", "storage", "redacted"}, "public_stop_receipt_required")
    native.require(all(stopped[key] == ready[key] for key in shared) and stopped["originalCommandId"] == ready["commandId"]
        and stopped["commandId"] != ready["commandId"] and isinstance(stopped["commandId"], str)
        and re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", stopped["commandId"])
        and stopped["profileId"] == profile["profileId"] and stopped["action"] == "database.runtime.stop"
        and stopped["status"] == "stopped" and stopped["storage"] == "verified" and stopped["redacted"] is True
        and type(stopped["observedAt"]) is int and stopped["observedAt"] >= ready["observedAt"]
        and isinstance(stopped["correlationId"], str) and 1 <= len(stopped["correlationId"]) <= 128, "original_operator_stop_identity_required")
    fingerprint = result["nativeStop"]["originalReplayFingerprint"]
    native.require(isinstance(fingerprint, str) and re.fullmatch(r"[a-f0-9]{64}", fingerprint), "opaque_original_fingerprint_required")
    preparation = {key: ready[key] for key in ("schemaVersion", "projectId", "databaseId", "engine", "planDigest", "environmentFingerprint")}
    preparation["profileId"] = profile["profileId"]
    authority = {"action": "project.update", "scope": {"kind": "project", "projectId": ready["projectId"]}}
    native.require(ready["inputDigest"] == digest({**preparation, **authority, "operation": "database.runtime.apply"}), "original_apply_digest_required")
    preparation.update(originalReceipt=ready, originalReplayFingerprint=fingerprint)
    native.require(stopped["inputDigest"] == digest({**preparation, **authority, "operation": "database.runtime.stop"}), "operator_stop_digest_required")
    exact(result["nativeStart"], {"receipt", "originalStopReplayFingerprint"}, "public_operator_start_required")
    started = result["nativeStart"]["receipt"]
    exact(started, set(ready) | {"originalCommandId", "originalStopCommandId", "profileId"}, "public_start_receipt_required")
    native.require(all(started[key] == ready[key] for key in shared)
        and started["originalCommandId"] == ready["commandId"] and started["originalStopCommandId"] == stopped["commandId"]
        and isinstance(started["commandId"], str) and re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", started["commandId"])
        and len({ready["commandId"], stopped["commandId"], started["commandId"]}) == 3
        and started["profileId"] == profile["profileId"] and started["action"] == "database.runtime.start"
        and started["status"] == "ready" and started["health"] == "passed" and started["storage"] == "verified"
        and started["redacted"] is True and type(started["idempotent"]) is bool
        and type(started["observedAt"]) is int and started["observedAt"] >= stopped["observedAt"]
        and isinstance(started["correlationId"], str) and 1 <= len(started["correlationId"]) <= 128,
        "original_operator_start_identity_required")
    stop_fingerprint = result["nativeStart"]["originalStopReplayFingerprint"]
    native.require(isinstance(stop_fingerprint, str) and re.fullmatch(r"[a-f0-9]{64}", stop_fingerprint), "opaque_stopped_fingerprint_required")
    preparation.update(originalStopReceipt=stopped, originalStopReplayFingerprint=stop_fingerprint)
    native.require(started["inputDigest"] == digest({**preparation, **authority, "operation": "database.runtime.start"}), "operator_start_digest_required")
    operator = result["operator"]
    flags = {"signedHttp": "passed", "postgresReplay": "passed", "originalRows": "unchanged", "cipherRows": "unchanged", "atomicAudit": "passed", "cacheOnlyReplay": "passed", "executorRemoved": "passed"}
    flags.update(startAtomicAudit="passed", startCacheOnlyReplay="passed", startExecutorRemoved="passed", stoppedCacheNoRestart="passed")
    exact(operator, set(flags) | {"applyCommand", "stopCommand", "startCommand", "stopDispatches", "startDispatches"}, "complete_operator_evidence_required")
    native.require(all(operator[key] == value for key, value in flags.items()) and type(operator["stopDispatches"]) is int
        and operator["stopDispatches"] == 1 and type(operator["startDispatches"]) is int and operator["startDispatches"] == 1, "executed_operator_boundaries_required")
    for key, receipt in (("applyCommand", ready), ("stopCommand", stopped), ("startCommand", started)):
        exact(operator[key], {"id", "correlationId", "status"}, "public_operator_command_required")
        native.require(operator[key] == {"id": receipt["commandId"], "correlationId": receipt["correlationId"], "status": "completed"}, "completed_original_operator_command_required")
    return result

def validate_report(report):
    native.require(isinstance(report, dict) and report.get("success") is True and all(type(report.get(key)) is int and report[key] == count
        for key, count in (("numTotalTests", 5), ("numPassedTests", 5), ("numFailedTests", 0), ("numPendingTests", 0))), "five_executed_operator_cases_required")
    suites = report.get("testResults")
    native.require(isinstance(suites, list) and len(suites) == 1 and isinstance(suites[0], dict)
        and isinstance(suites[0].get("name"), str) and suites[0]["name"].endswith("/apps/api/src/p5-native-operator.physical.test.ts"), "exact_operator_suite_required")
    cases = suites[0].get("assertionResults")
    expected = {"native operator physical " + engine + " startup stop and persistence" for engine in native.ENGINES}
    native.require(isinstance(cases, list) and len(cases) == 5 and all(isinstance(case, dict) for case in cases)
        and {case.get("fullName") for case in cases} == expected and all(case.get("status") == "passed" for case in cases), "exact_five_operator_titles_required")
    return 5

def validate_acceptance(value, binding):
    exact(value, {"schemaVersion", "commit", "runId", "runAttempt", "nonce", "engines", "database"}, "public_operator_acceptance_required")
    native.require(value["schemaVersion"] == 1 and all(value[key] == binding[key] for key in ("commit", "runId", "runAttempt", "nonce")), "original_operator_run_required")
    exact(value["database"], {"name", "cleanup"}, "public_operator_database_cleanup_required")
    native.require(value["database"] == {"name": binding["databaseName"], "cleanup": "verified"}, "original_operator_database_cleanup_required")
    exact(value["engines"], native.ENGINES, "all_five_operator_engines_required")
    for engine in native.ENGINES:
        validate_result(value["engines"][engine], binding["profiles"][engine])
    return 5

def verify(env):
    binding = admission.load(env)
    directory = Path(env["RUNNER_TEMP"]) / admission.DIRECTORY
    artifacts = {}
    for name in ("operator.json", "acceptance.json"):
        path = directory / name
        native.require(path.is_file() and not path.is_symlink() and path.stat().st_uid == os.getuid()
            and 0 < path.stat().st_size <= 1048576, "bounded_owned_operator_artifact_required")
        artifacts[name] = path.read_bytes()
    validate_report(json.loads(artifacts["operator.json"]))
    validate_acceptance(json.loads(artifacts["acceptance.json"]), binding)
    proof = {"schemaVersion": 1, "status": "verified", "cases": 5,
        **{key: binding[key] for key in ("commit", "runId", "runAttempt", "nonce")},
        "artifactHashes": {name: hashlib.sha256(data).hexdigest() for name, data in artifacts.items()}}
    descriptor = os.open(directory / "verified.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(proof, sort_keys=True, indent=2) + "\n")
    return proof

if __name__ == "__main__":
    native.require(len(sys.argv) == 2 and sys.argv[1] == "verify", "explicit_operator_verify_required")
    result = verify(os.environ)
    print(json.dumps({key: result[key] for key in ("status", "commit", "cases")}))
