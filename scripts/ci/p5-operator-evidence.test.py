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
    start_preparation = {**preparation, "originalStopReceipt": stopped, "originalStopReplayFingerprint": "2" * 64}
    started = {**ready, "action": "database.runtime.start", "commandId": "55555555-5555-4555-8555-555555555555",
        "originalCommandId": ready["commandId"], "originalStopCommandId": stopped["commandId"], "profileId": profile["profileId"],
        "inputDigest": digest({**start_preparation, "action": "project.update", "scope": {"kind": "project", "projectId": project}, "operation": "database.runtime.start"}),
        "correlationId": "start-correlation", "observedAt": 3000}
    result["nativeStart"] = {"receipt": started, "originalStopReplayFingerprint": "2" * 64}
    result["operator"].update(startCommand={"id": started["commandId"], "correlationId": started["correlationId"], "status": "completed"},
        startDispatches=1, startAtomicAudit="passed", startCacheOnlyReplay="passed", startExecutorRemoved="passed", stoppedCacheNoRestart="passed")
    public = {key:value for key,value in ready.items() if key not in {"action","commandId","inputDigest","correlationId","observedAt","status","health","idempotent"}}
    current_health = {}
    for index,(key,state,time) in enumerate((("runningBeforeStop","running",1500),("stopped","stopped",2500),("runningAfterStart","running",3500))):
        observation = {**public,"action":"database.runtime.health","originalCommandId":ready["commandId"],"profileId":profile["profileId"],
            "context":{"requestId":"health-request-"+str(index),"correlationId":"health-correlation-"+str(index)},"observedAt":time,
            "state":state,"health":"healthy" if state=="running" else "not-running","uid":result["uid"] if state=="running" else None}
        current_health[key] = {"observation":observation,"before":time-100,"after":time+100}
    result["currentHealth"] = current_health
    result["operator"].update(healthDispatches=3,healthSignedHttp="passed",healthNoLedgerWrites="passed",healthExecutorRemoved="passed")
    current_metrics = copy.deepcopy(current_health)
    for index,(key,proof) in enumerate(current_metrics.items()):
        observation=proof["observation"]
        observation.update(action="database.runtime.metrics",context={"requestId":"metrics-request-"+str(index),"correlationId":"metrics-correlation-"+str(index)},
            metrics=None if observation["state"]=="stopped" else {"cpuPercent":0.25,"memoryUsage":"5.629MiB / 512MiB","memoryPercent":1.1,"networkIO":"916B / 0B","blockIO":"147kB / 0B","pids":9},
            metricsObservedAt=None if observation["state"]=="stopped" else observation["observedAt"]-1)
    result["currentMetrics"]=current_metrics
    result["operator"].update(metricsDispatches=3,statsDispatches=2,metricsSignedHttp="passed",metricsNoLedgerWrites="passed",metricsExecutorRemoved="passed")
    current_logs = copy.deepcopy(current_health)
    for index,(name,proof) in enumerate(current_logs.items()):
        observation = proof["observation"]
        observation.update(action="database.runtime.logs",context={"requestId":"logs-request-"+str(index),"correlationId":"logs-correlation-"+str(index)},
            logs={"stdout":"ready\n","stderr":"notice\n","redacted":True},logsObservedAt=observation["observedAt"]-1)
        proof["selection"] = {"tail":100,**({"since":"1970-01-01T00:00:00.500Z"} if index else {})}
    result["currentLogs"] = current_logs
    result["operator"].update(publicOriginalSelectors="passed",logsDispatches=3,logReads=3,logsSignedHttp="passed",logsNoLedgerWrites="passed",logsExecutorRemoved="passed")
    result["confirmedAuthority"]={"projectId":project,"readOnly":"passed","originalNonce":"passed","acceptedAudit":"passed","detachedRejected":"passed","expiryRejected":"passed","reopen":"passed","originalRows":"unchanged","cipher":"unchanged"}
    result["confirmedClaim"]={"projectId":project,"originalNonce":"passed","uniqueAuthority":"passed","projectBusy":"passed","rollback":"passed","reopen":"passed","noRenewal":"passed","audit":"passed","originalRows":"unchanged","cipher":"unchanged"}
    result["confirmationRecovery"]={"projectId":project,"pending":"passed","unique":"passed","reopen":"passed","unconsumed":"passed","noAuthority":"passed","detachedRejected":"passed","originalRows":"unchanged","cipher":"unchanged"}
    result["browserAcceptance"]={"sourceCommit":"7e4875341dbb8e1afdeff23137403528f3af6382","engine":engine,"projectId":project,"databaseId":"orders","creation":"passed","selection":"passed","reload":"passed","telemetry":"passed","start":"passed","stop":"passed","persistence":"passed","browser":"chromium","context":"isolated","requests":12}
    deleted={**{key:value for key,value in ready.items() if key not in ("health","idempotent","commandId","observedAt","inputDigest","correlationId","status","storage","action")},"action":"database.runtime.delete","commandId":"delete1","originalCommandId":ready["commandId"],"originalStopCommandId":None,"confirmationId":"approval1","profileId":profile["profileId"],"inputDigest":"f"*64,"correlationId":"delete-correlation","observedAt":2000,"status":"removed","storage":"retained"}
    result["confirmedDeletion"]={"projectId":project,"receipt":deleted,"originalSources":"passed","apiTransport":"passed","prepareControl":"passed","prepareRoute":"passed","applyControl":"passed","applyRoute":"passed","inventoryRetirement":"passed","signatureRejected":"passed","confirmationRejected":"passed","originalNonce":"passed","signedHttp":"passed","effects":1,"rollback":"passed","cacheOnlyReopen":"passed","executorRemoved":"passed","retirement":"passed","retainedStorage":"passed","audit":"passed","originalRows":"unchanged","cipher":"unchanged"}
    result["confirmedDeletion"]["browserDeletion"]={**{key:result["browserAcceptance"][key] for key in ("sourceCommit","engine","projectId","databaseId","browser","context")},"preparation":"passed","confirmation":"passed","recovery":"passed","sameOriginalKey":"passed","inventory":"passed","reload":"passed","retainedStorage":"passed","requests":7}
    result=with_inventory(result,profile)
    if engine in ("postgres","mysql","mariadb","mongodb","redis"):add_native_backup(result,profile)
    return result,profile
def with_inventory(result, profile):
    result = copy.deepcopy(result)
    ready, stopped = result["receipt"], result["nativeStop"]["receipt"]
    base = {key:ready[key] for key in ("schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint")}
    base["profileId"] = profile["profileId"]
    source = {**base,"originalReceipt":ready,"originalReplayFingerprint":result["nativeStop"]["originalReplayFingerprint"]}
    start = {**source,"originalStopReceipt":stopped,"originalStopReplayFingerprint":result["nativeStart"]["originalStopReplayFingerprint"]}
    views = {}
    for name, time in (("runningBeforeStop",1450),("stopped",2450),("runningAfterStart",3450)):
        views[name] = {"entry":{"preparation":base,"connection":result["internalConnection"]["details"],"source":source,
            "startPreparation":None if name=="runningBeforeStop" else start},"before":time-50,"after":time+50,
            "requestId":"inventory-request-"+name,"correlationId":"inventory-correlation-"+name}
    result["inventoryRecovery"] = {"views":views,"restart":"passed","sourcesUsed":"passed","commands":"unchanged","cache":"unchanged","cipher":"unchanged","audit":"passed"}
    return result
class OperatorProofTests(unittest.TestCase):
    def test_requires_current_health_not_only_legacy_lifecycle_evidence(self):
        result,profile=fixture()
        del result["currentHealth"]
        for key in ("healthDispatches","healthSignedHttp","healthNoLedgerWrites","healthExecutorRemoved"):del result["operator"][key]
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_private_detached_stale_or_root_current_health(self):
        result,profile=fixture()
        for patch in ({"password":"private"},{"containerId":"0"*64},{"uid":0},{"observedAt":999},{"profileId":"foreign"},{"originalCommandId":"foreign"},{"state":"stopped"}):
            changed=copy.deepcopy(result);changed["currentHealth"]["runningBeforeStop"]["observation"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_rejects_missing_health_state_windows_or_side_effect_proof(self):
        result,profile=fixture()
        for patch in ({"before":1501},{"after":1499},{"after":100000},{"before":True}):
            changed=copy.deepcopy(result);changed["currentHealth"]["runningBeforeStop"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
        for key in ("healthSignedHttp","healthNoLedgerWrites","healthExecutorRemoved","healthDispatches"):
            changed=copy.deepcopy(result);changed["operator"][key]=2 if key=="healthDispatches" else "not-run"
            with self.subTest(key=key),self.assertRaises(RuntimeError):module.validate_result(changed,profile)

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
        for pair in fixtures.values():
            pair[0]["browserAcceptance"]["sourceCommit"]="a"*40
            pair[0]["confirmedDeletion"]["browserDeletion"]["sourceCommit"]="a"*40
        binding = {"commit": "a" * 40, "runId": "123", "runAttempt": "1", "nonce": "b" * 24,
            "databaseName": "deploylite_p5_operator_" + "b" * 24, "profiles": {engine: pair[1] for engine, pair in fixtures.items()}}
        acceptance = {"schemaVersion": 1, **{key: binding[key] for key in ("commit", "runId", "runAttempt", "nonce")},
            "engines": {engine: pair[0] for engine, pair in fixtures.items()}, "database": {"name": binding["databaseName"], "cleanup": "verified"}}
        self.assertEqual(module.validate_acceptance(acceptance, binding), 5)
        for patch in [{"commit": "c" * 40}, {"runAttempt": "2"}, {"nonce": "c" * 24},
                {"database": {"name": "foreign", "cleanup": "verified"}}, {"database": {"name": binding["databaseName"], "cleanup": "pending"}}, {"password": "private"}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_acceptance({**acceptance, **patch}, binding)
    def test_requires_executed_operator_start_instead_of_fixture_restart(self):
        result, profile = fixture()
        del result["nativeStart"]
        with self.assertRaises(RuntimeError): module.validate_result(result, profile)

    def test_rejects_detached_start_and_omitted_execution_replay_or_audit(self):
        result, profile = fixture()
        for patch in [{"originalStopCommandId": result["receipt"]["commandId"]}, {"originalCommandId": "foreign"},
                {"inputDigest": "0" * 64}, {"observedAt": 1999}, {"containerId": "0" * 64}, {"password": "private"},
                {"commandId": result["nativeStop"]["receipt"]["commandId"]}]:
            changed = copy.deepcopy(result); changed["nativeStart"]["receipt"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_result(changed, profile)
        for key, value in {"startDispatches": 2, "startAtomicAudit": "not-run", "startCacheOnlyReplay": "not-run",
                "startExecutorRemoved": "not-run", "stoppedCacheNoRestart": "not-run"}.items():
            changed = copy.deepcopy(result); changed["operator"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.validate_result(changed, profile)

    def test_report_requires_all_five_passed_cases_without_skips(self):
        report = {"success": True, "numTotalTests": 5, "numPassedTests": 5, "numFailedTests": 0, "numPendingTests": 0,
            "testResults": [{"name": "/workspace/apps/api/src/p5-native-operator.physical.test.ts", "assertionResults": [
                {"fullName": "native operator physical " + engine + " startup stop and persistence", "status": "passed"} for engine in module.native.ENGINES]}]}
        self.assertEqual(module.validate_report(report), 5)
        for patch in [{"numPendingTests": 1}, {"numFailedTests": 1}, {"numPassedTests": 4}, {"success": False}, {"numTotalTests": 4}]:
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_report({**report, **patch})
        for cases in [report["testResults"][0]["assertionResults"][:-1], [{"fullName": "foreign", "status": "passed"}] * 5]:
            with self.subTest(cases=cases), self.assertRaises(RuntimeError): module.validate_report({**report, "testResults": [{**report["testResults"][0], "assertionResults": cases}]})
    def test_requires_three_current_metrics_states_not_only_health(self):
        result,profile=fixture(); del result["currentMetrics"]
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_detached_private_stale_and_fabricated_metrics(self):
        result,profile=fixture()
        for patch in [{"uid":float(result["uid"])},{"schemaVersion":True},{"redacted":1},{"containerId":"0"*64},{"metricsObservedAt":1399},{"metricsObservedAt":1601},{"metricsObservedAt":None},{"password":"private"},
                {"metrics":None},{"metrics":{**result["currentMetrics"]["runningBeforeStop"]["observation"]["metrics"],"pids":0}},
                {"metrics":{**result["currentMetrics"]["runningBeforeStop"]["observation"]["metrics"],"cpuPercent":float("inf")}},
                {"metrics":{**result["currentMetrics"]["runningBeforeStop"]["observation"]["metrics"],"memoryUsage":"private"}},
                {"metrics":{**result["currentMetrics"]["runningBeforeStop"]["observation"]["metrics"],"password":"private"}}]:
            changed=copy.deepcopy(result);changed["currentMetrics"]["runningBeforeStop"]["observation"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
        changed=copy.deepcopy(result);changed["currentMetrics"]["runningAfterStart"]["before"]=2999
        with self.assertRaises(RuntimeError):module.validate_result(changed,profile)
        changed=copy.deepcopy(result);changed["currentMetrics"]["stopped"]["observation"].update(metrics={"cpuPercent":0},metricsObservedAt=2500)
        with self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_actual_scoped_stats_and_readonly_signed_metrics(self):
        result,profile=fixture()
        for key,value in {"metricsDispatches":2,"statsDispatches":3,"metricsSignedHttp":"not-run","metricsNoLedgerWrites":"not-run","metricsExecutorRemoved":"not-run"}.items():
            changed=copy.deepcopy(result);changed["operator"][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_current_logs_not_only_metrics_and_lifecycle(self):
        result,profile=fixture()
        result.pop("currentLogs",None)
        for key in ("logsDispatches","logReads","logsSignedHttp","logsNoLedgerWrites","logsExecutorRemoved"):result["operator"].pop(key,None)
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_accepts_only_redacted_labelled_values_and_url_userinfo(self):
        result,profile=fixture()
        for proof in result["currentLogs"].values():
            proof["observation"]["logs"].update(stdout='{"password":"[REDACTED]"}\n',stderr='postgres://[REDACTED]@db.test/orders\n')
        module.validate_result(result,profile)
    def test_rejects_private_unsafe_unredacted_or_oversized_log_streams(self):
        result,profile=fixture()
        for patch in ({"password":"private"},{"redacted":False},{"stdout":"password=tiny"},{"stderr":"api_key='tiny private'"},
                {"stdout":"a"*64},{"stderr":"postgres://user:private@db.test/orders"},{"stdout":"pass\x1b[31mword=tiny"},
                {"stdout":"é"*524289},{"stdout":"\ud800"}):
            changed=copy.deepcopy(result);changed["currentLogs"]["runningBeforeStop"]["observation"]["logs"].update(patch)
            with self.subTest(patch=tuple(patch)),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_rejects_detached_log_identity_time_types_and_query_window(self):
        result,profile=fixture()
        for patch in ({"containerId":"0"*64},{"uid":True},{"schemaVersion":1.0},{"logsObservedAt":1399},{"logsObservedAt":1501},{"password":"private"}):
            changed=copy.deepcopy(result);changed["currentLogs"]["runningBeforeStop"]["observation"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
        changed=copy.deepcopy(result);changed["currentLogs"]["runningAfterStart"]["before"]=2999
        with self.assertRaises(RuntimeError):module.validate_result(changed,profile)
        changed=copy.deepcopy(result);changed["currentLogs"]["stopped"]["observation"]["context"]=copy.deepcopy(changed["currentLogs"]["runningBeforeStop"]["observation"]["context"])
        with self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_rejects_unbounded_private_local_or_future_log_selection(self):
        result,profile=fixture()
        for selection in ({"tail":0},{"tail":-1},{"tail":100.0},{"tail":True},{"tail":5001},{"tail":100,"password":"private"},
                {"tail":100,"since":"1m"},{"tail":100,"since":"1970-01-01T00:00:00"},{"tail":100,"since":"1970-01-01T00:00:02.000Z"},
                {"tail":100,"since":"1970-02-31T00:00:00.000Z"}):
            changed=copy.deepcopy(result);changed["currentLogs"]["runningBeforeStop"]["selection"]=selection
            with self.subTest(selection=selection),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_three_actual_scoped_log_reads_and_signed_readonly_execution(self):
        result,profile=fixture()
        for key,value in {"logsDispatches":2,"logReads":2,"logsSignedHttp":"not-run","logsNoLedgerWrites":"not-run","logsExecutorRemoved":"not-run"}.items():
            changed=copy.deepcopy(result);changed["operator"][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_public_original_selectors(self):
        result,profile=fixture()
        result["operator"].pop("publicOriginalSelectors",None)
        with self.assertRaises(RuntimeError): module.validate_result(result,profile)

    def test_requires_inventory_recovery_after_actual_reopen(self):
        result, profile = fixture(); del result["inventoryRecovery"]
        with self.assertRaises(RuntimeError): module.validate_result(result, profile)
    def test_accepts_bound_recovered_inventory_for_all_five_engines(self):
        for engine in module.native.ENGINES:
            result, profile = fixture(engine)
            with self.subTest(engine=engine): module.validate_result(with_inventory(result,profile),profile)
    def test_rejects_missing_recovery_views_or_unexecuted_boundaries(self):
        result, profile = fixture(); result = with_inventory(result,profile)
        for key in ("restart","sourcesUsed","commands","cache","cipher","audit"):
            changed = copy.deepcopy(result); changed["inventoryRecovery"][key] = "not-run"
            with self.subTest(key=key), self.assertRaises(RuntimeError): module.validate_result(changed,profile)
        for name in result["inventoryRecovery"]["views"]:
            changed = copy.deepcopy(result); del changed["inventoryRecovery"]["views"][name]
            with self.subTest(name=name), self.assertRaises(RuntimeError): module.validate_result(changed,profile)
    def test_rejects_detached_or_private_inventory_entries(self):
        result, profile = fixture(); result = with_inventory(result,profile)
        for patch in ({"source":None},{"password":"private"},{"startPreparation":None}):
            changed = copy.deepcopy(result); changed["inventoryRecovery"]["views"]["stopped"]["entry"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_result(changed,profile)
        for field,value in (("projectId","foreign"),("engine","redis"),("planDigest","0"*64)):
            changed = copy.deepcopy(result); changed["inventoryRecovery"]["views"]["stopped"]["entry"]["preparation"][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError): module.validate_result(changed,profile)
    def test_rejects_stale_duplicate_or_private_inventory_requests(self):
        result, profile = fixture(); result = with_inventory(result,profile)
        for patch in ({"before":False},{"after":999},{"before":1999},{"after":100000},{"password":"private"}):
            changed = copy.deepcopy(result); changed["inventoryRecovery"]["views"]["stopped"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(RuntimeError): module.validate_result(changed,profile)
        changed = copy.deepcopy(result)
        for key in ("requestId","correlationId"):
            changed["inventoryRecovery"]["views"]["stopped"][key] = changed["inventoryRecovery"]["views"]["runningBeforeStop"][key]
        with self.assertRaises(RuntimeError): module.validate_result(changed,profile)

class BrowserProofTests(unittest.TestCase):
    def test_requires_real_browser_boundary(self):
        result,profile=fixture()
        result.pop("browserAcceptance",None)
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_skipped_detached_private_or_shared_browser_proof(self):
        result,profile=fixture()
        for patch in ({"start":"skipped"},{"creation":"pending"},{"projectId":"foreign"},{"databaseId":"foreign"},{"engine":"redis"},{"context":"shared"},{"sourceCommit":"main"},{"requests":True},{"requests":1001},{"password":"private"}):
            changed=copy.deepcopy(result);changed["browserAcceptance"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_accepts_five_engines_with_exact_browser_proof(self):
        for engine in module.native.ENGINES:
            result,profile=fixture(engine)
            result["browserAcceptance"]={"sourceCommit":"7e4875341dbb8e1afdeff23137403528f3af6382","engine":engine,"projectId":result["receipt"]["projectId"],"databaseId":"orders","creation":"passed","selection":"passed","reload":"passed","telemetry":"passed","start":"passed","stop":"passed","persistence":"passed","browser":"chromium","context":"isolated","requests":12}
            with self.subTest(engine=engine):module.validate_result(result,profile)
    def test_requires_executed_original_confirmation_recovery(self):
        result,profile=fixture();del result["confirmationRecovery"]
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_incomplete_detached_or_private_confirmation_recovery(self):
        result,profile=fixture()
        for patch in ({"pending":"skipped"},{"unique":"pending"},{"reopen":"not-run"},{"unconsumed":"failed"},{"noAuthority":"failed"},{"detachedRejected":"failed"},{"originalRows":"changed"},{"cipher":"changed"},{"projectId":"foreign"},{"nonce":"private"}):
            changed=copy.deepcopy(result);changed["confirmationRecovery"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_executed_atomic_confirmed_claim(self):
        result,profile=fixture();del result["confirmedClaim"]
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_skipped_or_private_confirmed_claim(self):
        result,profile=fixture()
        for patch in ({"originalNonce":"skipped"},{"uniqueAuthority":"pending"},{"projectBusy":"not-run"},{"rollback":"failed"},{"reopen":"failed"},{"noRenewal":"failed"},{"audit":"failed"},{"cipher":"changed"},{"projectId":"foreign"},{"confirmationId":"private"}):
            changed=copy.deepcopy(result);changed["confirmedClaim"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_requires_executed_confirmed_authority_proof(self):
        result,profile=fixture();del result["confirmedAuthority"]
        with self.assertRaises(RuntimeError):module.validate_result(result,profile)
    def test_rejects_skipped_detached_or_private_confirmed_authority(self):
        result,profile=fixture()
        for patch in ({"readOnly":"skipped"},{"originalNonce":"pending"},{"acceptedAudit":"not-run"},{"detachedRejected":"failed"},{"expiryRejected":"failed"},{"reopen":"failed"},{"cipher":"changed"},{"projectId":"foreign"},{"confirmationId":"private"}):
            changed=copy.deepcopy(result);changed["confirmedAuthority"].update(patch)
            with self.subTest(patch=patch),self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_rejects_browser_source_detached_from_exact_run(self):
        fixtures={engine:fixture(engine) for engine in module.native.ENGINES}
        binding={"commit":"a"*40,"runId":"123","runAttempt":"1","nonce":"b"*24,"databaseName":"deploylite_p5_operator_"+"b"*24,"profiles":{engine:pair[1] for engine,pair in fixtures.items()}}
        acceptance={"schemaVersion":1,**{key:binding[key] for key in ("commit","runId","runAttempt","nonce")},"engines":{engine:pair[0] for engine,pair in fixtures.items()},"database":{"name":binding["databaseName"],"cleanup":"verified"}}
        with self.assertRaises(RuntimeError):module.validate_acceptance(acceptance,binding)
class ConfirmedDeletionProof(unittest.TestCase):
    def test_requires_actual_signed_confirmed_deletion(self):
        result,profile=fixture();del result["confirmedDeletion"]
        with self.assertRaises(RuntimeError):module.validate_confirmed_deletion(result,profile)

    def test_refuses_skipped_duplicate_effect_or_incomplete_signed_delete(self):
        result,profile=fixture()
        for patch in ({"signedHttp":"skipped"},{"rollback":"not-run"},{"effects":2},{"effects":True},{"retirement":"pending"},{"cipher":"changed"},{"projectId":"foreign"},{"password":"private"}):
            changed=copy.deepcopy(result);changed["confirmedDeletion"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_result(changed,profile)
    def test_refuses_detached_removal_scope_storage_or_approval(self):
        result,profile=fixture()
        for patch in ({"confirmationId":""},{"originalCommandId":"foreign"},{"containerId":"0"*64},{"storage":"removed"},{"observedAt":999},{"password":"private"}):
            changed=copy.deepcopy(result);changed["confirmedDeletion"]["receipt"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_result(changed,profile)

class ConfirmedDeletionTransportProof(unittest.TestCase):
    def test_requires_actual_api_transport_and_original_source_corroboration(self):
        for key in ("originalSources","apiTransport","prepareControl","prepareRoute","applyControl","applyRoute","inventoryRetirement","browserDeletion"):
            result,profile=fixture();result["confirmedDeletion"].pop(key,None)
            with self.assertRaises(RuntimeError):module.validate_confirmed_deletion(result,profile)

class DestructiveBrowserEvidence(unittest.TestCase):
    def test_rejects_foreign_shared_or_omitted_destructive_browser(self):
        result,profile=fixture()
        for patch in ({"sourceCommit":"a"*40},{"context":"shared"},{"sameOriginalKey":"skipped"},{"recovery":"pending"},{"requests":0},{"projectId":"foreign"},{"password":"private"}):
            changed=copy.deepcopy(result);changed["confirmedDeletion"]["browserDeletion"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_confirmed_deletion(changed,profile)
        for key in result["confirmedDeletion"]["browserDeletion"]:
            changed=copy.deepcopy(result);changed["confirmedDeletion"]["browserDeletion"].pop(key)
            with self.assertRaises(RuntimeError):module.validate_confirmed_deletion(changed,profile)

def add_native_backup(result,profile):
    ready=result["receipt"]
    keys=("schemaVersion","projectId","databaseId","engine","agentId","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt","storage","redacted")
    receipt={key:ready[key] for key in keys}
    source={key:ready[key] for key in ("schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint")}
    source.update(profileId=profile["profileId"],originalReceipt=ready,originalReplayFingerprint=result["nativeStop"]["originalReplayFingerprint"])
    receipt.update(action="database.runtime.backup",commandId="66666666-6666-4666-8666-666666666666",originalCommandId=ready["commandId"],profileId=profile["profileId"],
        inputDigest=digest({**source,"action":"project.update","scope":{"kind":"project","projectId":ready["projectId"]},"operation":"database.runtime.backup","destinationId":"private-native","maxBytes":2097152}),
        correlationId="backup-correlation",volumeKey="db-orders",observedAt=1500,destinationId="private-native",sourceDigest=digest(source),format="mongodb-archive-gzip" if profile["engine"]=="mongodb" else "postgres-custom-gzip" if profile["engine"]=="postgres" else profile["engine"]+"-sql-gzip",consistency="quiesced-writes" if profile["engine"]=="mongodb" else "native-snapshot" if profile["engine"]=="postgres" else "global-read-lock",
        status="created",archiveId="backup_"+hashlib.sha256((ready["projectId"]+"\0"+"66666666-6666-4666-8666-666666666666"+"\0private-native").encode()).hexdigest()[:32],archiveBytes=512,archiveSha256="2"*64,manifestSha256="3"*64,idempotent=False)
    proof={"receipt":receipt,"maxBytes":2097152,"captures":1,**{key:"passed" for key in ("signedHttp","restorePreparation","archiveIntegrity","formatValidated","seededRow","restoredData","restoreCleanup","inventoryReopen","replay","privateFiles","cleanup")}}
    if profile["engine"] in ("mysql","mariadb","mongodb"):proof["writersResumed"]="passed"
    else:proof.update(restoredData="passed",restoreCleanup="passed")
    if profile["engine"]=="redis":receipt.update(format="volume-tar",consistency="all-consumers-stopped",observedAt=result["nativeStop"]["receipt"]["observedAt"]);proof.update(stoppedSource="passed",sourceCleanup="passed")
    proof["pendingRestore"]={"commandId":"77777777-7777-4777-8777-777777777777","confirmationId":"88888888-8888-4888-8888-888888888888","actorId":"actor-a",**{key:ready[key] for key in ("projectId","databaseId","engine")},
        "inputDigest":digest({**source,"backupReceipt":receipt,"maxBytes":proof["maxBytes"],"action":"project.update","scope":{"kind":"project","projectId":ready["projectId"]},"operation":"database.runtime.restore"}),
        "idempotencyKey":"fixture_restore_pending_"+profile["engine"],"correlationId":"fixture-restore-pending-"+profile["engine"],"expiresAt":20000,
        "status":"pending_confirmation","classification":"destructive","consumedAt":None,"reopen":"passed","sameOriginalKey":"passed","sameOriginalNonce":"passed","dispatches":0,"authenticatedApi":"passed","protectedArchive":"passed","signedArchive":"passed","configuredArchive":"passed"}
    result["nativeBackup"]=proof
    return result,profile

def native_backup_fixture():
    return fixture()

class NativeBackupProof(unittest.TestCase):
    def test_refuses_incomplete_pending_restore_metadata(self):
        result,profile=native_backup_fixture()
        for key in result["nativeBackup"]["pendingRestore"]:
            changed=copy.deepcopy(result);changed["nativeBackup"]["pendingRestore"].pop(key)
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)

    def test_refuses_detached_consumed_or_executed_pending_restore(self):
        result,profile=native_backup_fixture()
        for patch in ({"inputDigest":"0"*64},{"projectId":"foreign"},{"engine":"redis"},{"consumedAt":1000},{"dispatches":1},{"dispatches":False},{"sameOriginalNonce":"skipped"},{"reopen":"pending"},{"expiresAt":0},{"privatePath":"private-fixture"}):
            changed=copy.deepcopy(result);changed["nativeBackup"]["pendingRestore"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)

    def test_requires_original_durable_pending_restore_nonce(self):
        result,profile=native_backup_fixture()
        result["nativeBackup"].pop("pendingRestore",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

    def test_refuses_missing_verified_restore_preparation(self):
        result,profile=add_native_backup(*native_backup_fixture())
        result["nativeBackup"].pop("restorePreparation",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

    def test_refuses_missing_private_archive_integrity(self):
        result,profile=add_native_backup(*native_backup_fixture())
        result["nativeBackup"].pop("archiveIntegrity",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

    def test_accepts_exact_private_postgres_capture(self):
        result,profile=native_backup_fixture();module.validate_native_backup(result,profile)
    def test_requires_every_actual_dump_proof(self):
        result,profile=native_backup_fixture()
        for key in result["nativeBackup"]:
            changed=copy.deepcopy(result);del changed["nativeBackup"][key]
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)
    def test_refuses_omitted_or_reexecuted_capture(self):
        result,profile=native_backup_fixture()
        for patch in ({"captures":2},{"captures":True},{"formatValidated":"skipped"},{"seededRow":"pending"},{"restoredData":"pending"},{"restoreCleanup":"pending"},{"cleanup":"unknown"},{"privatePath":"private"}):
            changed=copy.deepcopy(result);changed["nativeBackup"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)
    def test_refuses_detached_receipt_or_oversized_archive(self):
        result,profile=native_backup_fixture()
        for patch in ({"containerId":"0"*64},{"sourceDigest":"0"*64},{"inputDigest":"0"*64},{"originalCommandId":"foreign"},{"archiveBytes":2097153},{"format":"mysql-sql-gzip"},{"idempotent":True},{"password":"private"}):
            changed=copy.deepcopy(result);changed["nativeBackup"]["receipt"].update(patch)
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)

class SqlNativeBackupProof(unittest.TestCase):
    def test_accepts_actual_mysql_dump_and_resumed_writers(self):
        result,profile=fixture("mysql");add_native_backup(result,profile);self.assertEqual(module.validate_result(result,profile),result)
    def test_accepts_actual_mariadb_dump_and_resumed_writers(self):
        result,profile=fixture("mariadb");add_native_backup(result,profile);self.assertEqual(module.validate_result(result,profile),result)
    def test_refuses_unproved_writer_resume(self):
        for engine in ("mysql","mariadb"):
            result,profile=fixture(engine);add_native_backup(result,profile)
            for value in (None,"skipped","pending"):
                changed=copy.deepcopy(result)
                if value is None:del changed["nativeBackup"]["writersResumed"]
                else:changed["nativeBackup"]["writersResumed"]=value
                with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)
    def test_does_not_accept_sql_global_lock_for_other_engines(self):
        result,profile=fixture();result["nativeBackup"]["receipt"]["consistency"]="global-read-lock"
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

class RedisNativeBackupProof(unittest.TestCase):
    def test_accepts_actual_stopped_redis_archive_and_restore(self):
        result,profile=fixture("redis");add_native_backup(result,profile)
        result["nativeBackup"]["receipt"].update(format="volume-tar",consistency="all-consumers-stopped",observedAt=result["nativeStop"]["receipt"]["observedAt"])
        result["nativeBackup"].update(stoppedSource="passed",sourceCleanup="passed")
        self.assertEqual(module.validate_result(result,profile),result)

class MongoNativeBackupProof(unittest.TestCase):
    def test_requires_complete_mongo_dump_restore_and_writers(self):
        result,profile=fixture("mongodb")
        self.assertEqual(module.validate_result(result,profile),result)
    def test_refuses_missing_locked_or_skipped_mongo_writers(self):
        result,profile=fixture("mongodb")
        for value in (None,"skipped","pending"):
            changed=copy.deepcopy(result)
            if value is None:del changed["nativeBackup"]["writersResumed"]
            else:changed["nativeBackup"]["writersResumed"]=value
            with self.assertRaises(RuntimeError):module.validate_native_backup(changed,profile)

class RestorePreparationApiProof(unittest.TestCase):
    def test_refuses_missing_actual_restore_prepare_api(self):
        result,profile=fixture();result["nativeBackup"]["pendingRestore"].pop("authenticatedApi",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

class RestoreProtectionProof(unittest.TestCase):
    def test_refuses_missing_actual_durable_restore_protection(self):
        result,profile=fixture();result["nativeBackup"]["pendingRestore"].pop("protectedArchive",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

class RestoreArchiveChannelProof(unittest.TestCase):
    def test_refuses_missing_actual_signed_archive_channel(self):
        result,profile=fixture();result["nativeBackup"]["pendingRestore"].pop("signedArchive",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

class ConfiguredRestoreArchiveProof(unittest.TestCase):
    def test_refuses_missing_actual_configured_archive_api(self):
        result,profile=fixture();result["nativeBackup"]["pendingRestore"].pop("configuredArchive",None)
        with self.assertRaises(RuntimeError):module.validate_native_backup(result,profile)

if __name__ == "__main__":
    unittest.main()
