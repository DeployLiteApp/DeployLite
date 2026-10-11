"""Public operator proof only; validation never executes native engines or SQL."""
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
import math
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

def validate_log_text(value):
    native.require(isinstance(value,str) and not re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]",value),"normalized_public_log_text_required")
    native.require(not re.search(r"\b((?:sk|pk|ghp|glpat|dop|dl)_[A-Za-z0-9_\-]{8,}|[A-Za-z0-9+/]{32,}={0,2})\b",value),"unlabelled_log_secrets_forbidden")
    labels = r"\b([A-Za-z0-9_-]{0,128}(?:password|passwd|secret|token|authorization|api[_-]?key|cookie|credential)[A-Za-z0-9_-]{0,128})([\"']?\s*[:=]\s*)(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;}]+)"
    for match in re.finditer(labels,value,re.I):
        native.require(match[3] in ("[REDACTED]",'"[REDACTED]"',"'[REDACTED]'"),"labelled_log_secrets_forbidden")
    for match in re.finditer(r"\b[a-z][a-z0-9+.-]*://([^/?#\s]*)@",value,re.I):
        native.require(match[1]=="[REDACTED]","log_url_credentials_forbidden")
    try:return len(value.encode("utf-8"))
    except UnicodeEncodeError:native.require(False,"valid_public_log_encoding_required")

def validate_current_logs(result,shared,ready,stopped,started):
    proofs=result["currentLogs"]
    exact(proofs,{"runningBeforeStop","stopped","runningAfterStart"},"three_current_logs_states_required")
    contexts=set()
    for name,state,lower,upper in (("runningBeforeStop","running",ready["observedAt"],stopped["observedAt"]),
            ("stopped","stopped",stopped["observedAt"],started["observedAt"]),("runningAfterStart","running",started["observedAt"],9007199254740991)):
        proof=proofs[name];exact(proof,{"observation","before","after","selection"},"current_logs_window_selection_required")
        observation=proof["observation"]
        exact(observation,shared|{"action","originalCommandId","profileId","context","observedAt","state","health","uid","storage","redacted","logs","logsObservedAt"},"public_current_logs_required")
        exact(observation["context"],{"requestId","correlationId"},"current_logs_context_required")
        native.require(all(isinstance(value,str) and 1<=len(value)<=256 for value in observation["context"].values()),"current_logs_request_scope_required")
        contexts.add((observation["context"]["requestId"],observation["context"]["correlationId"]))
        identity=shared|{"originalCommandId","profileId","state","health","uid","storage","redacted"}
        native.require(all(observation[key]==result["currentHealth"][name]["observation"][key] for key in identity)
            and observation["action"]=="database.runtime.logs" and type(observation["schemaVersion"]) is int and observation["schemaVersion"]==1
            and observation["redacted"] is True and (type(observation["uid"]) is int and observation["uid"]==result["uid"] if state=="running" else observation["uid"] is None),"current_logs_identity_state_required")
        before,after,observed,sampled=proof["before"],proof["after"],observation["observedAt"],observation["logsObservedAt"]
        native.require(all(type(value) is int and 0<=value<=9007199254740991 for value in (before,after,observed,sampled))
            and ready["observedAt"]<=before<=sampled<=observed<=after and after-before<60000 and lower<=before<=after<=upper,"current_logs_chronology_required")
        logs=observation["logs"];exact(logs,{"stdout","stderr","redacted"},"strict_public_log_streams_required")
        native.require(logs["redacted"] is True,"redacted_public_logs_required")
        size=validate_log_text(logs["stdout"])+validate_log_text(logs["stderr"])
        native.require(0<size<=1048576,"bounded_actual_log_output_required")
        selection=proof["selection"]
        native.require(isinstance(selection,dict) and set(selection) in ({"tail"},{"tail","since"}) and type(selection["tail"]) is int and 1<=selection["tail"]<=5000,"bounded_current_log_selection_required")
        if "since" in selection:
            since=selection["since"]
            native.require(isinstance(since,str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",since),"canonical_current_logs_since_required")
            try:
                time=datetime.fromisoformat(since.replace("Z","+00:00"));delta=time-datetime(1970,1,1,tzinfo=timezone.utc)
                milliseconds=delta.days*86400000+delta.seconds*1000+delta.microseconds//1000
                native.require(time.isoformat(timespec="milliseconds").replace("+00:00","Z")==since and 0<=milliseconds<=before,"nonfuture_current_logs_since_required")
            except (ValueError,OverflowError):native.require(False,"canonical_current_logs_since_required")
    native.require(len(contexts)==3,"distinct_current_logs_requests_required")

def validate_current_metrics(result, shared, ready, stopped, started):
    proofs=result["currentMetrics"]
    exact(proofs,{"runningBeforeStop","stopped","runningAfterStart"},"three_current_metrics_states_required")
    contexts=set()
    for name,state,lower,upper in (("runningBeforeStop","running",ready["observedAt"],stopped["observedAt"]),
            ("stopped","stopped",stopped["observedAt"],started["observedAt"]),("runningAfterStart","running",started["observedAt"],9007199254740991)):
        proof=proofs[name];exact(proof,{"observation","before","after"},"current_metrics_window_required")
        observation=proof["observation"]
        exact(observation,shared | {"action","originalCommandId","profileId","context","observedAt","state","health","uid","storage","redacted","metrics","metricsObservedAt"},"public_current_metrics_required")
        exact(observation["context"],{"requestId","correlationId"},"current_metrics_context_required")
        native.require(all(isinstance(value,str) and 1 <= len(value) <= 256 for value in observation["context"].values()),"current_metrics_request_scope_required")
        contexts.add((observation["context"]["requestId"],observation["context"]["correlationId"]))
        identity=shared | {"originalCommandId","profileId","state","health","uid","storage","redacted"}
        native.require(all(observation[key]==result["currentHealth"][name]["observation"][key] for key in identity)
            and observation["action"]=="database.runtime.metrics" and type(observation["schemaVersion"]) is int and observation["schemaVersion"]==1
            and observation["redacted"] is True and (type(observation["uid"]) is int and observation["uid"]==result["uid"] if state=="running" else observation["uid"] is None),"current_metrics_identity_state_required")
        before,after,observed=proof["before"],proof["after"],observation["observedAt"]
        native.require(all(type(value) is int and 0 <= value <= 9007199254740991 for value in (before,after,observed))
            and ready["observedAt"] <= before <= observed <= after and after-before < 60000 and lower <= before <= after <= upper,"current_metrics_chronology_required")
        metrics,sampled=observation["metrics"],observation["metricsObservedAt"]
        if state=="stopped":native.require(metrics is None and sampled is None,"stopped_metrics_must_be_absent")
        else:
            native.require(type(sampled) is int and before <= sampled <= observed,"current_metrics_sample_window_required")
            exact(metrics,{"cpuPercent","memoryUsage","memoryPercent","networkIO","blockIO","pids"},"strict_public_counters_required")
            native.require(all(type(metrics[key]) in (int,float) and 0 <= metrics[key] <= 1.7976931348623157e308 and math.isfinite(metrics[key]) for key in ("cpuPercent","memoryPercent"))
                and type(metrics["pids"]) is int and 0 < metrics["pids"] <= 9007199254740991,"current_metrics_numeric_counters_required")
            quantity=r"[0-9]{1,16}(?:\.[0-9]{1,6})?(?:B|kB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)"
            native.require(all(isinstance(metrics[key],str) and re.fullmatch(quantity+r" / "+quantity,metrics[key]) for key in ("memoryUsage","networkIO","blockIO")),"rounded_public_metrics_pairs_required")
    native.require(len(contexts)==3,"distinct_current_metrics_requests_required")

def validate_inventory_recovery(result, profile, ready, stopped, started):
    proof = result["inventoryRecovery"]
    exact(proof,{"views","restart","sourcesUsed","commands","cache","cipher","audit"},"complete_inventory_recovery_required")
    native.require(all(proof[key]==value for key,value in {"restart":"passed","sourcesUsed":"passed","commands":"unchanged","cache":"unchanged","cipher":"unchanged","audit":"passed"}.items()),"executed_inventory_recovery_required")
    views = proof["views"]
    exact(views,{"runningBeforeStop","stopped","runningAfterStart"},"three_recovered_inventory_views_required")
    base = {key:ready[key] for key in ("schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint")}
    base["profileId"] = profile["profileId"]
    source = {**base,"originalReceipt":ready,"originalReplayFingerprint":result["nativeStop"]["originalReplayFingerprint"]}
    start = {**source,"originalStopReceipt":stopped,"originalStopReplayFingerprint":result["nativeStart"]["originalStopReplayFingerprint"]}
    contexts = set()
    for name,lower,upper in (("runningBeforeStop",ready["observedAt"],stopped["observedAt"]),("stopped",stopped["observedAt"],started["observedAt"]),("runningAfterStart",started["observedAt"],9007199254740991)):
        view = views[name]
        exact(view,{"entry","before","after","requestId","correlationId"},"public_inventory_recovery_window_required")
        entry = view["entry"]
        exact(entry,{"preparation","connection","source","startPreparation"},"strict_public_inventory_entry_required")
        native.require(entry=={"preparation":base,"connection":result["internalConnection"]["details"],"source":source,"startPreparation":None if name=="runningBeforeStop" else start},"original_inventory_sources_required")
        before,after = view["before"],view["after"]
        native.require(all(type(value) is int and 0<=value<=9007199254740991 for value in (before,after)) and lower<=before<=after<=upper and after-before<60000,"fresh_inventory_recovery_window_required")
        native.require(all(isinstance(view[key],str) and 1<=len(view[key])<=256 for key in ("requestId","correlationId")),"correlated_inventory_recovery_required")
        contexts.add((view["requestId"],view["correlationId"]))
    native.require(len(contexts)==3,"distinct_inventory_recovery_requests_required")

def validate_browser_acceptance(result, source_commit):
    proof=result["browserAcceptance"]
    stages={"creation","selection","reload","telemetry","start","stop","persistence"}
    exact(proof,stages|{"sourceCommit","engine","projectId","databaseId","browser","context","requests"},"complete_browser_evidence_required")
    native.require(isinstance(source_commit,str) and re.fullmatch(r"[a-f0-9]{40}",source_commit) and proof["sourceCommit"]==source_commit and proof["browser"]=="chromium" and proof["context"]=="isolated"
        and all(proof[key]==result["receipt"][key] for key in ("engine","projectId","databaseId"))
        and all(proof[key]=="passed" for key in stages) and type(proof["requests"]) is int and 1<=proof["requests"]<=1000,"executed_scoped_browser_evidence_required")

def validate_confirmation_recovery(result):
    proof=result["confirmationRecovery"]
    stages={"pending","unique","reopen","unconsumed","noAuthority","detachedRejected"}
    exact(proof,stages|{"projectId","originalRows","cipher"},"complete_confirmation_recovery_required")
    native.require(proof["projectId"]==result["receipt"]["projectId"] and all(proof[key]=="passed" for key in stages)
        and proof["originalRows"]=="unchanged" and proof["cipher"]=="unchanged","executed_scoped_confirmation_recovery_required")

def validate_confirmed_claim(result):
    proof=result["confirmedClaim"]
    stages={"originalNonce","uniqueAuthority","projectBusy","rollback","reopen","noRenewal","audit"}
    exact(proof,stages|{"projectId","originalRows","cipher"},"complete_confirmed_claim_required")
    native.require(proof["projectId"]==result["receipt"]["projectId"] and all(proof[key]=="passed" for key in stages)
        and proof["originalRows"]=="unchanged" and proof["cipher"]=="unchanged","executed_scoped_confirmed_claim_required")

def validate_confirmed_authority(result):
    proof=result["confirmedAuthority"]
    stages={"readOnly","originalNonce","acceptedAudit","detachedRejected","expiryRejected","reopen"}
    exact(proof,stages|{"projectId","originalRows","cipher"},"complete_confirmed_authority_required")
    native.require(proof["projectId"]==result["receipt"]["projectId"] and all(proof[key]=="passed" for key in stages)
        and proof["originalRows"]=="unchanged" and proof["cipher"]=="unchanged","executed_scoped_confirmed_authority_required")

def validate_confirmed_deletion(result,profile):
    proof=result.get("confirmedDeletion")
    stages={"originalSources","apiTransport","prepareControl","prepareRoute","applyControl","applyRoute","inventoryRetirement","signatureRejected","confirmationRejected","originalNonce","signedHttp","rollback","cacheOnlyReopen","executorRemoved","retirement","retainedStorage","audit"}
    exact(proof,stages|{"projectId","receipt","effects","originalRows","cipher","browserDeletion"},"confirmed_deletion_required")
    native.require(proof["projectId"]==result["receipt"]["projectId"] and all(proof[key]=="passed" for key in stages)
        and type(proof["effects"]) is int and proof["effects"]==1 and proof["originalRows"]=="unchanged" and proof["cipher"]=="unchanged","actual_one_confirmed_deletion_required")
    browser=proof["browserDeletion"];browser_stages={"preparation","confirmation","recovery","sameOriginalKey","inventory","reload","retainedStorage"}
    exact(browser,browser_stages|{"sourceCommit","engine","projectId","databaseId","browser","context","requests"},"complete_destructive_browser_required")
    native.require(browser["sourceCommit"]==result["browserAcceptance"]["sourceCommit"] and browser["browser"]=="chromium" and browser["context"]=="isolated"
        and all(browser[key]==result["receipt"][key] for key in ("projectId","databaseId","engine")) and all(browser[key]=="passed" for key in browser_stages)
        and type(browser["requests"]) is int and 1<=browser["requests"]<=1000,"actual_original_confirmation_browser_recovery_required")
    removed,original=proof["receipt"],result["receipt"]
    shared={"schemaVersion","projectId","databaseId","engine","agentId","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"}
    exact(removed,shared|{"action","commandId","originalCommandId","originalStopCommandId","confirmationId","profileId","inputDigest","correlationId","observedAt","status","storage","redacted"},"strict_confirmed_deleted_receipt_required")
    native.require(all(removed[key]==original[key] for key in shared) and removed["originalCommandId"]==original["commandId"] and removed["originalStopCommandId"] is None
        and removed["commandId"]!=original["commandId"] and removed["profileId"]==profile["profileId"] and removed["action"]=="database.runtime.delete"
        and removed["status"]=="removed" and removed["storage"]=="retained" and removed["redacted"] is True,"confirmed_delete_original_storage_required")
    native.require(isinstance(removed["confirmationId"],str) and re.fullmatch(r"[A-Za-z0-9_-]{1,200}",removed["confirmationId"])
        and isinstance(removed["inputDigest"],str) and re.fullmatch(r"[a-f0-9]{64}",removed["inputDigest"])
        and type(removed["observedAt"]) is int and original["observedAt"]<=removed["observedAt"]<=9007199254740991,"confirmed_deleted_binding_required")

def validate_native_backup(result, profile):
    proof=result.get("nativeBackup")
    exact(proof,{"receipt","maxBytes","captures","signedHttp","formatValidated","seededRow","restoredData","restoreCleanup","inventoryReopen","replay","privateFiles","cleanup"}|({"writersResumed"} if profile["engine"] in ("mysql","mariadb","mongodb") else {"stoppedSource","sourceCleanup"} if profile["engine"]=="redis" else set()),"complete_actual_native_dump_required")
    native.require(profile["engine"] in ("postgres","mysql","mariadb","mongodb","redis") and type(proof["captures"]) is int and proof["captures"]==1
        and type(proof["maxBytes"]) is int and proof["maxBytes"]==2097152
        and all(proof[key]=="passed" for key in ("signedHttp","formatValidated","seededRow","restoredData","restoreCleanup","inventoryReopen","replay","privateFiles","cleanup")),"executed_private_postgres_dump_required")
    if profile["engine"] in ("mysql","mariadb","mongodb"):native.require(proof["writersResumed"]=="passed","actual_sql_writers_resumed_required")
    if profile["engine"]=="postgres":native.require(proof["restoredData"]==proof["restoreCleanup"]=="passed","actual_postgres_restore_required")
    if profile["engine"]=="redis":native.require(proof["stoppedSource"]==proof["sourceCleanup"]=="passed","actual_stopped_redis_source_required")
    receipt,ready=proof["receipt"],result["receipt"]
    shared={"schemaVersion","projectId","databaseId","engine","agentId","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt","storage","redacted"}
    exact(receipt,shared|{"action","commandId","originalCommandId","profileId","inputDigest","correlationId","volumeKey","observedAt","destinationId","sourceDigest","format","consistency","status","archiveId","archiveBytes","archiveSha256","manifestSha256","idempotent"},"strict_native_dump_receipt_required")
    source={key:ready[key] for key in ("schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint")}
    source.update(profileId=profile["profileId"],originalReceipt=ready,originalReplayFingerprint=result["nativeStop"]["originalReplayFingerprint"])
    expected=digest({**source,"action":"project.update","scope":{"kind":"project","projectId":ready["projectId"]},"operation":"database.runtime.backup","destinationId":"private-native","maxBytes":proof["maxBytes"]})
    native.require(all(receipt[key]==ready[key] for key in shared) and receipt["originalCommandId"]==ready["commandId"]
        and isinstance(receipt["commandId"],str) and re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}",receipt["commandId"])
        and receipt["commandId"]!=ready["commandId"] and receipt["profileId"]==profile["profileId"]
        and receipt["action"]=="database.runtime.backup" and receipt["inputDigest"]==expected and receipt["sourceDigest"]==digest(source)
        and receipt["destinationId"]=="private-native" and receipt["volumeKey"]=="db-"+ready["databaseId"]
        and receipt["format"]==("mongodb-archive-gzip" if profile["engine"]=="mongodb" else "volume-tar" if profile["engine"]=="redis" else "postgres-custom-gzip" if profile["engine"]=="postgres" else profile["engine"]+"-sql-gzip") and receipt["consistency"]==("quiesced-writes" if profile["engine"]=="mongodb" else "all-consumers-stopped" if profile["engine"]=="redis" else "native-snapshot" if profile["engine"]=="postgres" else "global-read-lock")
        and receipt["status"]=="created" and receipt["idempotent"] is False
        and type(receipt["archiveBytes"]) is int and 0<receipt["archiveBytes"]<=proof["maxBytes"]
        and type(receipt["observedAt"]) is int and (result["nativeStop"]["receipt"]["observedAt"]<=receipt["observedAt"]<=result["nativeStart"]["receipt"]["observedAt"] if profile["engine"]=="redis" else ready["observedAt"]<=receipt["observedAt"]<=result["nativeStop"]["receipt"]["observedAt"])
        and all(isinstance(receipt[key],str) and re.fullmatch(r"[a-f0-9]{64}",receipt[key]) for key in ("archiveSha256","manifestSha256"))
        and isinstance(receipt["correlationId"],str) and 1<=len(receipt["correlationId"])<=256,"original_bounded_native_dump_required")
    archive="backup_"+hashlib.sha256((ready["projectId"]+"\0"+receipt["commandId"]+"\0private-native").encode()).hexdigest()[:32]
    native.require(receipt["archiveId"]==archive,"original_private_archive_id_required")

def validate_result(result, profile, source_commit="7e4875341dbb8e1afdeff23137403528f3af6382"):
    exact(result, {"receipt", "uid", "original", "nativeStop", "nativeStart", "currentHealth", "currentMetrics", "currentLogs", "inventoryRecovery", "browserAcceptance", "confirmationRecovery", "confirmedClaim", "confirmedAuthority", "confirmedDeletion", "internalConnection", "authenticatedProbe", "restart", "persistence", "cleanup", "operator"}|({"nativeBackup"} if profile["engine"] in ("postgres","mysql","mariadb","mongodb","redis") else set()), "public_operator_result_required")
    native.require(type(result["uid"]) is int and 0 < result["uid"] <= 4294967294
        and all(result[key] == "passed" for key in ("authenticatedProbe", "restart", "persistence"))
        and result["cleanup"] == "verified", "executed_operator_persistence_cleanup_required")
    if profile["engine"] in ("postgres","mysql","mariadb","mongodb","redis"):validate_native_backup(result,profile)
    validate_browser_acceptance(result,source_commit)
    validate_confirmation_recovery(result)
    validate_confirmed_claim(result)
    validate_confirmed_authority(result)
    validate_confirmed_deletion(result,profile)
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
    health = result["currentHealth"]
    exact(health, {"runningBeforeStop","stopped","runningAfterStart"}, "three_current_health_states_required")
    contexts = set()
    for name,state,lower,upper in (("runningBeforeStop","running",ready["observedAt"],stopped["observedAt"]),
            ("stopped","stopped",stopped["observedAt"],started["observedAt"]),
            ("runningAfterStart","running",started["observedAt"],9007199254740991)):
        proof = health[name]
        exact(proof,{"observation","before","after"},"current_health_window_required")
        observation = proof["observation"]
        exact(observation,shared | {"action","originalCommandId","profileId","context","observedAt","state","health","uid","storage","redacted"},"public_current_health_required")
        exact(observation["context"],{"requestId","correlationId"},"current_health_context_required")
        native.require(all(isinstance(value,str) and 1 <= len(value) <= 256 for value in observation["context"].values()),"current_health_request_scope_required")
        contexts.add((observation["context"]["requestId"],observation["context"]["correlationId"]))
        native.require(all(observation[key]==ready[key] for key in shared) and observation["action"]=="database.runtime.health"
            and observation["originalCommandId"]==ready["commandId"] and observation["profileId"]==profile["profileId"]
            and observation["storage"]=="verified" and observation["redacted"] is True and observation["state"]==state
            and observation["health"]==("healthy" if state=="running" else "not-running")
            and (type(observation["uid"]) is int and observation["uid"]==result["uid"] if state=="running" else observation["uid"] is None),"current_health_identity_state_required")
        before,after,observed=proof["before"],proof["after"],observation["observedAt"]
        native.require(all(type(value) is int and 0 <= value <= 9007199254740991 for value in (before,after,observed))
            and ready["observedAt"] <= before <= observed <= after and after-before < 60000
            and lower <= observed <= upper,"current_health_chronology_required")
    native.require(len(contexts)==3,"distinct_current_health_requests_required")
    validate_current_metrics(result,shared,ready,stopped,started)
    validate_current_logs(result,shared,ready,stopped,started)
    validate_inventory_recovery(result,profile,ready,stopped,started)
    operator = result["operator"]
    flags = {"signedHttp": "passed", "postgresReplay": "passed", "originalRows": "unchanged", "cipherRows": "unchanged", "atomicAudit": "passed", "cacheOnlyReplay": "passed", "executorRemoved": "passed"}
    flags.update(publicOriginalSelectors="passed",logsSignedHttp="passed",logsNoLedgerWrites="passed",logsExecutorRemoved="passed",metricsSignedHttp="passed",metricsNoLedgerWrites="passed",metricsExecutorRemoved="passed",healthSignedHttp="passed",healthNoLedgerWrites="passed",healthExecutorRemoved="passed",startAtomicAudit="passed", startCacheOnlyReplay="passed", startExecutorRemoved="passed", stoppedCacheNoRestart="passed")
    exact(operator, set(flags) | {"applyCommand", "stopCommand", "startCommand", "stopDispatches", "startDispatches", "healthDispatches", "metricsDispatches", "statsDispatches", "logsDispatches", "logReads"}, "complete_operator_evidence_required")
    native.require(all(operator[key] == value for key, value in flags.items()) and type(operator["stopDispatches"]) is int
        and operator["stopDispatches"] == 1 and type(operator["startDispatches"]) is int and operator["startDispatches"] == 1 and type(operator["healthDispatches"]) is int and operator["healthDispatches"] == 3 and type(operator["metricsDispatches"]) is int and operator["metricsDispatches"]==3
        and type(operator["statsDispatches"]) is int and operator["statsDispatches"]==2
        and type(operator["logsDispatches"]) is int and operator["logsDispatches"]==3 and type(operator["logReads"]) is int and operator["logReads"]==3, "executed_operator_boundaries_required")
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
        validate_result(value["engines"][engine], binding["profiles"][engine], source_commit=binding["commit"])
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
