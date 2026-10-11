import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location("proof", Path(__file__).with_name("p5-operator-evidence.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
def fixture(engine="postgres"):
    profile = json.loads((module.admission.ROOT / "scripts/ci/p5-native-profiles.json").read_text())["profiles"][engine]
    project = "11111111-1111-4111-8111-111111111111"
    prefix = "dl-" + hashlib.sha256(project.encode()).hexdigest()[:32]
    ready = {"schemaVersion": 1, "projectId": project, "databaseId": "orders", "engine": engine, "action": "database.runtime",
        "agentId": "22222222-2222-4222-8222-222222222222", "commandId": "33333333-3333-4333-8333-333333333333",
        "inputDigest": "a" * 64, "planDigest": "b" * 64, "environmentFingerprint": "c" * 32, "correlationId": "original-correlation",
        "containerId": "d" * 64, "imageId": "sha256:" + "e" * 64, "volumeName": prefix + "-vol-db-orders", "networkName": prefix + "-net-db-orders",
        "networkId": "f" * 64, "volumeCreatedAt": "2026-10-10T00:00:00Z", "observedAt": 1000, "status": "ready", "health": "passed",
        "storage": "verified", "idempotent": False, "redacted": True}
    preparation = {key: ready[key] for key in ("schemaVersion", "projectId", "databaseId", "engine", "planDigest", "environmentFingerprint")}
    preparation["profileId"] = profile["profileId"]
    ready["inputDigest"] = digest({**preparation, "action": "project.update", "scope": {"kind": "project", "projectId": project}, "operation": "database.runtime.apply"})
    preparation.update(originalReceipt=ready, originalReplayFingerprint="1" * 64)
    stopped = {key: ready[key] for key in ("schemaVersion", "projectId", "databaseId", "engine", "agentId", "planDigest", "environmentFingerprint",
        "containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt", "storage", "redacted")}
    stopped.update(action="database.runtime.stop", commandId="44444444-4444-4444-8444-444444444444", originalCommandId=ready["commandId"],
        profileId=profile["profileId"], inputDigest=digest({**preparation, "action": "project.update", "scope": {"kind": "project", "projectId": project}, "operation": "database.runtime.stop"}),
        correlationId="stop-correlation", observedAt=2000, status="stopped")
    connection = {"schemaVersion": 1, "projectId": project, "databaseId": "orders", "engine": engine, "profileId": profile["profileId"],
        "planDigest": ready["planDigest"], "availability": "planned", "exposure": "internal", "hostname": "db-orders", "networkName": ready["networkName"],
        "port": profile["containerPort"], "databaseName": "0" if engine == "redis" else "orders", "username": "default" if engine == "redis" else "dl_" + "a" * 12, "authenticationDatabase": "admin" if engine == "mongodb" else None}
    result = {"receipt": ready, "uid": 1000, "original": {"projectId": project, "databaseId": "orders", "commandId": ready["commandId"], "planDigest": ready["planDigest"],
        "volume": {"name": ready["volumeName"], "createdAt": ready["volumeCreatedAt"]}, "network": {"name": ready["networkName"], "id": ready["networkId"]}},
        "nativeStop": {"receipt": stopped, "originalReplayFingerprint": "1" * 64}, "internalConnection": {"details": connection, "authenticatedRead": "passed", "afterRestart": "passed"},
        "authenticatedProbe": "passed", "restart": "passed", "persistence": "passed", "cleanup": "verified",
        "operator": {"applyCommand": {"id": ready["commandId"], "correlationId": ready["correlationId"], "status": "completed"},
            "stopCommand": {"id": stopped["commandId"], "correlationId": stopped["correlationId"], "status": "completed"},
            "signedHttp": "passed", "postgresReplay": "passed", "originalRows": "unchanged", "cipherRows": "unchanged", "atomicAudit": "passed",
            "stopDispatches": 1, "cacheOnlyReplay": "passed", "executorRemoved": "passed"}}
    return result, profile
class OperatorProofTests(unittest.TestCase):
    def test_exact_public_original_and_distinct_operator_stop(self):
        result, profile = fixture()
        self.assertEqual(module.validate_result(result, profile), result)
    def test_rejects_missing_operator_proof_or_database_cache_audit_flags(self):
        result, profile = fixture()
        for change in [{"operator": None}, *[{"operator": {**result["operator"], key: value}} for key, value in
            {"signedHttp": "not-run", "postgresReplay": "not-run", "cipherRows": "changed", "originalRows": "changed", "atomicAudit": "not-run",
             "stopDispatches": 2, "cacheOnlyReplay": "not-run", "executorRemoved": "not-run"}.items()]]:
            with self.subTest(change=change), self.assertRaises(RuntimeError): module.validate_result({**result, **change}, profile)
    def test_rejects_original_or_stop_identity_digest_clock_and_secret_changes(self):
        result, profile = fixture()
        for patch in [{"containerId": "a" * 64}, {"originalCommandId": "foreign"}, {"inputDigest": "0" * 64},
            {"observedAt": 999}, {"profileId": "foreign"}, {"password": "private"}, {"commandId": result["receipt"]["commandId"]}]:
            altered = copy.deepcopy(result)
            altered["nativeStop"]["receipt"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_result(altered, profile)
        for patch in [{"password": "private"}, {"uid": 0}, {"cleanup": "pending"}, {"restart": "not-run"}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_result({**result, **patch}, profile)
    def test_acceptance_requires_original_run_database_and_all_engines(self):
        result, profile = fixture()
        binding = {"commit": "a" * 40, "runId": "123", "runAttempt": "1", "nonce": "b" * 24,
            "databaseName": "deploylite_p5_operator_" + "b" * 24, "profiles": {"postgres": profile}}
        # Every engine must be validated against its own profile, so this partial proof must fail.
        acceptance = {"schemaVersion": 1, **{key: binding[key] for key in ("commit", "runId", "runAttempt", "nonce")},
            "engines": {"postgres": result}, "database": {"name": binding["databaseName"], "cleanup": "verified"}}
        with self.assertRaises(RuntimeError): module.validate_acceptance(acceptance, binding)
    def test_all_engine_acceptance_and_run_cleanup_binding(self):
        fixtures = {engine: fixture(engine) for engine in module.native.ENGINES}
        binding = {"commit": "a" * 40, "runId": "123", "runAttempt": "1", "nonce": "b" * 24,
            "databaseName": "deploylite_p5_operator_" + "b" * 24, "profiles": {engine: pair[1] for engine, pair in fixtures.items()}}
        acceptance = {"schemaVersion": 1, **{key: binding[key] for key in ("commit", "runId", "runAttempt", "nonce")},
            "engines": {engine: pair[0] for engine, pair in fixtures.items()}, "database": {"name": binding["databaseName"], "cleanup": "verified"}}
        self.assertEqual(module.validate_acceptance(acceptance, binding), 5)
        for patch in [{"commit": "c" * 40}, {"runAttempt": "2"}, {"nonce": "c" * 24},
                {"database": {"name": "foreign", "cleanup": "verified"}}, {"database": {"name": binding["databaseName"], "cleanup": "pending"}}, {"password": "private"}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_acceptance({**acceptance, **patch}, binding)
    def test_report_requires_all_five_passed_cases_without_skips(self):
        report = {"success": True, "numTotalTests": 5, "numPassedTests": 5, "numFailedTests": 0, "numPendingTests": 0,
            "testResults": [{"name": "/workspace/apps/api/src/p5-native-operator.physical.test.ts", "assertionResults": [
                {"fullName": "native operator physical " + engine + " startup stop and persistence", "status": "passed"} for engine in module.native.ENGINES]}]}
        self.assertEqual(module.validate_report(report), 5)
        for patch in [{"numPendingTests": 1}, {"numFailedTests": 1}, {"numPassedTests": 4}, {"success": False}, {"numTotalTests": 4}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_report({**report, **patch})
        for cases in [report["testResults"][0]["assertionResults"][:-1], [{"fullName": "foreign", "status": "passed"}] * 5]:
            with self.subTest(cases=cases), self.assertRaises(RuntimeError): module.validate_report({**report, "testResults": [{**report["testResults"][0], "assertionResults": cases}]})
if __name__ == "__main__":
    unittest.main()
