"""Prospective source guards, NOT RUN. All boundaries are recorded fakes.

No Docker process, registry, port, config contents or credential access is used.
Synthetic report/inspection values below are unit fixtures, never runtime proof.
"""
import copy
import hashlib
import json
import runpy
import unittest
from pathlib import Path

H = runpy.run_path(str(Path(__file__).with_name("p2-physical-acceptance.py")))
M = json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
ID = "a" * 64
IMAGE = "sha256:" + "b" * 64
JOB = {"repository": "fixture/deploylite", "runId": "123", "runAttempt": "1", "job": "p2-docker-acceptance"}

class FakeBoundary:
    def __init__(self):
        self.calls = []
        self.now = 0.0
        self.elapsed = 0.0
    def run(self, argv, **options):
        self.calls.append((argv, options))
        self.now += self.elapsed
        return {"returncode": 0, "stdout": "recorded-only", "stderr": ""}

class ProspectivePhysicalGuards(unittest.TestCase):
    def setUp(self):
        self.env = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": JOB["repository"],
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": JOB["job"], "GITHUB_SHA": "c" * 40,
                    "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": "/tmp/fresh-private-empty-config",
                    "DEPLOYLITE_DOCKER_RUNTIME_GRANT": "P2_PHYSICAL_DOCKER_APPROVED"}
        self.grant = {"authorization": "P2_PHYSICAL_DOCKER_APPROVED", "grantId": "fixture-grant-123456789", "runId": "11111111-1111-4111-8111-111111111111",
                      "engineScope": "ephemeral-github-actions-job", "ciJob": JOB.copy(), "commit": "c" * 40,
                      "expiresAtMs": 60000, "dockerHost": self.env["DOCKER_HOST"], "dockerConfigDirectory": self.env["DOCKER_CONFIG"],
                      "engineId": "explicit-recorded-engine-123", "platform": "linux/amd64", "engineOs": "linux", "engineArchitecture": "x86_64",
                      "owner": "p2v-fixture", "projectId": "22222222-2222-4222-8222-222222222222",
                      "bounds": M["resourceProposal"].copy(), "expiryClosures": {"cleanupMaxMs": 30000},
                      "sourceHashes": {p: "d" * 64 for p in M["sourceFiles"]}}
        self.fake = FakeBoundary()
    def rejected_context(self, grant=None, env=None):
        with self.assertRaises(H["PhysicalError"]): H["validate_context"](grant or self.grant, self.env if env is None else env, 0)
        self.assertEqual(self.fake.calls, [])
    def test_missing_explicit_runtime_grant_is_rejected(self):
        self.rejected_context(env={k:v for k,v in self.env.items() if k != "DEPLOYLITE_DOCKER_RUNTIME_GRANT"})
    def test_nonhosted_and_missing_hosted_identity_are_rejected(self):
        for value in (None, "self-hosted"):
            with self.subTest(runner=value): self.rejected_context(env={**self.env, "RUNNER_ENVIRONMENT": value})
    def test_wrong_job_run_attempt_repository_or_commit_are_rejected(self):
        for field in ("GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY", "GITHUB_SHA"):
            with self.subTest(field=field): self.rejected_context(env={**self.env, field: "foreign"})
    def test_expired_grant_cannot_prepare_a_new_fixture(self):
        self.rejected_context(grant={**self.grant, "expiresAtMs": -1})
    def test_ambient_context_or_tls_cannot_enter_the_command_boundary(self):
        for field in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            with self.subTest(field=field): self.rejected_context(env={**self.env, field: "ambient"})
    def test_native_engine_platform_id_and_socket_are_bound(self):
        for field,value in [("engineId", ""), ("platform", "linux/arm64"), ("engineOs", "windows"), ("dockerHost", "tcp://foreign:2375")]:
            with self.subTest(field=field): self.rejected_context(grant={**self.grant, field:value})
    def test_protected_ports_and_widened_owned_caps_are_rejected(self):
        for field,value in [("registryPort", 3000),("physicalPorts",[31849,31859]),("registryCpu",2),("registryMemoryBytes",0),
                            ("fixtureCpu",2),("fixtureMemoryBytes",0),("physicalMaxContainers",4),("prepMaxContainers",3),("cleanupMaxSeconds",31)]:
            with self.subTest(field=field): self.rejected_context(grant={**self.grant,"bounds":{**self.grant["bounds"],field:value}})
    def test_private_config_type_symlink_owner_mode_and_emptiness_are_checked(self):
        valid={"directory":True,"symlink":False,"owned":True,"mode":0o700}
        for change,entries in [({"directory":False},[]),({"symlink":True},[]),({"owned":False},[]),({"mode":0o755},[]),({},["config.json"])]:
            with self.subTest(change=change,entries=entries):
                with self.assertRaises(H["PhysicalError"]): H["validate_config"]({**valid,**change},entries)
    def test_missing_changed_or_extra_current_source_hashes_fail_closed(self):
        expected=self.grant["sourceHashes"]
        for current in [{}, {**expected,next(iter(expected)):"e"*64}, {**expected,"foreign.ts":"d"*64}]:
            with self.subTest(current=current): self.assertFalse(H["validate_sources"](expected,current))
    def test_observed_manifest_hash_must_match_header_not_image_id(self):
        body=b'{"schemaVersion":2,"config":{"digest":"sha256:' + b'b'*64 + b'"}}'
        repository="127.0.0.1:49172/deploylite-p2/fixture"
        for digest in (IMAGE,"sha256:"+"e"*64,"latest"):
            with self.subTest(digest=digest):
                with self.assertRaises(H["PhysicalError"]): H["manifest_reference"](body,digest,repository)
    def image(self):
        return {"id":IMAGE,"repoDigests":["127.0.0.1:49172/deploylite-p2/fixture@sha256:"+"e"*64],"platform":"linux/amd64",
                "user":"65532:65532","command":["/bin/busybox","httpd","-f","-p","8080","-h","/www"],"healthIntervalNs":1000000000,
                "healthTimeoutNs":1000000000,"healthPath":"/healthz","flavor":"a"}
    def test_image_id_only_wrong_repo_digest_user_platform_or_health_are_rejected(self):
        expected={"reference":self.image()["repoDigests"][0],"platform":"linux/amd64","flavor":"a"}
        for field,value in [("repoDigests",[]),("platform","linux/arm64"),("user","0:0"),("command",["sh"]),("healthIntervalNs",0),("healthPath","http://foreign")]:
            with self.subTest(field=field):
                with self.assertRaises(H["PhysicalError"]): H["validate_image"]({**self.image(),field:value},expected)
    def resource(self):
        return {"id":ID,"kind":"registry","owner":self.grant["owner"],"projectId":self.grant["projectId"],"imageId":IMAGE,
                "imageRef":M["fixture"]["registry"],"cpuNano":500000000,"memoryBytes":268435456,"pids":64,
                "networkId":"f"*64,"hostIp":"127.0.0.1","hostPort":49172,"readonly":True,"privileged":False,"binds":[],"labelsVerified":True}
    def test_exact_owned_ids_labels_images_network_and_limits_are_checked_before_removal(self):
        owned=self.resource()
        for field,value in [("id","e"*64),("owner","foreign"),("projectId","foreign"),("imageId","sha256:"+"e"*64),("networkId","e"*64),
                            ("cpuNano",0),("memoryBytes",0),("pids",0),("hostIp","0.0.0.0"),("hostPort",3000),("privileged",True),("binds",["/private"])]:
            with self.subTest(field=field):
                with self.assertRaises(H["PhysicalError"]): H["validate_owned_resource"]({**owned,field:value},owned,self.grant["bounds"])
    def test_preparation_plan_uses_pins_serial_a_h_builds_and_derived_exact_digest_pulls(self):
        plan=H["preparation_plan"](self.grant,M)
        builds=[step for step in plan if step["kind"]=="build"]
        self.assertEqual([step["target"] for step in builds],["a","h"])
        self.assertTrue(all("--network=none" in step["argv"] and "--pull=false" in step["argv"] for step in builds))
        self.assertTrue(all(step["context"]==M["fixture"]["context"] for step in builds))
        self.assertEqual([step["image"] for step in plan if step["kind"]=="input-pull"],[M["fixture"]["base"],M["fixture"]["registry"]])
        self.assertTrue(any(step["kind"]=="registry-removed-before-cases" for step in plan))
    def test_every_command_has_explicit_config_host_no_shell_and_effect_deadline(self):
        argv=["docker","info"]
        H["run_effect"](argv,self.grant,self.fake)
        actual,options=self.fake.calls[0]
        self.assertEqual(actual[:5],["docker","--config",self.env["DOCKER_CONFIG"],"--host",self.env["DOCKER_HOST"]])
        self.assertNotIn("shell",options);self.assertLessEqual(options["timeout"],120)
    def test_fresh_effect_after_expiry_and_postexpiry_recovery_without_final_binding_are_rejected(self):
        self.fake.now=61
        for closure in (None,{"kind":"recovery","deadline":121}):
            with self.subTest(closure=closure):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","start",ID],self.grant,self.fake,closure)
        self.assertEqual(self.fake.calls,[])
    def test_postexpiry_cleanup_requires_explicit_nonrenewing_deadline_and_exact_recorded_ids(self):
        self.fake.now=61
        for closure in (None,{"kind":"cleanup","deadline":60},{"kind":"cleanup","deadline":92},{"kind":"cleanup","deadline":62,"ownedIds":[]}):
            with self.subTest(closure=closure):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","rm","--force",ID],self.grant,self.fake,closure)
    def test_process_timeout_does_not_create_verified_preparation_or_renew_total_budget(self):
        self.fake.elapsed=121
        with self.assertRaises(H["PhysicalError"]): H["run_effect"](["docker","build","fixture"],self.grant,self.fake)
    def test_global_daemon_mutation_prune_foreign_network_and_tagged_inputs_are_never_planned(self):
        for argv in (["docker","system","prune"],["docker","update","--memory","1g",ID],["docker","network","rm","foreign"],
                     ["docker","pull","busybox:latest"],["docker","build","--network=host","."]):
            with self.subTest(argv=argv):
                with self.assertRaises(H["PhysicalError"]): H["run_effect"](argv,self.grant,self.fake)
        self.assertEqual(self.fake.calls,[])
    def report(self):
        titles=M["suites"]["docker"]["guardTitles"]+M["suites"]["docker"]["physicalTitles"]
        return {"success":True,"numTotalTests":len(titles),"numPassedTests":len(titles),"numPendingTests":0,"numFailedTests":0,
                "testResults":[{"assertionResults":[{"fullName":t,"title":next(c["title"] for c in M["suites"]["docker"]["guardCases"]+M["suites"]["docker"]["physicalCases"] if c["fullName"]==t),"status":"passed"} for t in titles]}]}
    def verify(self,report):
        expected=M["suites"]["docker"]["guardTitles"]+M["suites"]["docker"]["physicalTitles"]
        return H["verify_report"](report,expected)
    def test_old_guard_only_report_cannot_count_as_physical_acceptance(self):
        report=self.report();count=M["suites"]["docker"]["guardCount"];report["testResults"][0]["assertionResults"]=report["testResults"][0]["assertionResults"][:count]
        report.update(numTotalTests=count,numPassedTests=count)
        self.assertFalse(self.verify(report))
    def test_missing_duplicate_changed_unexpected_or_skipped_expected_title_is_rejected(self):
        original=self.report()
        for fault in ("missing","duplicate","changed","unexpected","skipped"):
            with self.subTest(fault=fault):
                report=copy.deepcopy(original);cases=report["testResults"][0]["assertionResults"]
                if fault=="missing":cases.pop()
                elif fault=="duplicate":cases[-1]=copy.deepcopy(cases[0])
                elif fault=="changed":cases[-1]["fullName"]="stale-title"
                elif fault=="unexpected":cases.append({"fullName":"unreviewed title","status":"passed"})
                else:cases[-1]["status"]="skipped"
                report.update(numTotalTests=len(cases),numPassedTests=len(cases))
                self.assertFalse(self.verify(report))
    def test_failed_empty_or_count_inconsistent_reports_are_rejected(self):
        for field,value in [("numTotalTests",0),("numPassedTests",0),("numFailedTests",1),("numPendingTests",1),("testResults",[])]:
            with self.subTest(field=field): self.assertFalse(self.verify({**self.report(),field:value}))
    def receipts(self):
        values=[]
        for index,title in enumerate(M["suites"]["docker"]["physicalTitles"]):
            cid=f"{index+1:064x}";network="f"*64
            proof={"containerId":cid,"runtimeHost":"22222222-2222-4222-8222-222222222222","projectId":self.grant["projectId"],
                   "snapshotOriginId":"origin-fixture","snapshotHash":"d"*64,"effectiveImageDigest":"sha256:"+"e"*64,
                   "network":"p2v-fixture","hostPort":49170,"containerPort":8080}
            events=[{"kind":"owned-engine-observation","engineId":self.grant["engineId"],"ciJob":JOB.copy()},
                    {"kind":"docker-command","physicalRan":True,"phase":"completed","exitCode":0,"argv":["docker","run","--pull=never"]},
                    {"kind":"owned-container-budget","containerId":cid,"id":cid,"cpu":500000000,"memory":67108864,"pids":64},
                    {"kind":"physical-observation","observation":{"id":cid,"owner":self.grant["owner"],"projectId":self.grant["projectId"]}},
                    {"kind":"api-response","action":"INITIAL","statusCode":200,"body":{"data":{"deployment":{"executionReceipt":proof}}}},
                    {"kind":"cleanup-receipt","resource":"container","id":cid,"verifiedLabels":True,"removed":True},
                    {"kind":"cleanup-receipt","resource":"network","id":network,"verifiedLabels":True,"removed":True}]
            resources=[{"kind":"container","id":cid,"owner":self.grant["owner"],"project":self.grant["projectId"]},
                       {"kind":"network","id":network,"owner":self.grant["owner"],"project":self.grant["projectId"]}]
            if title.endswith("WIRE_unsigned_REJECTS_BEFORE_EFFECTS") or title.endswith("WIRE_signed-other-initial_REJECTS_BEFORE_EFFECTS"):
                tamper="unsigned" if title.endswith("WIRE_unsigned_REJECTS_BEFORE_EFFECTS") else "signed-other-initial"
                # Tamper cases require rejection/no proof; they cannot satisfy a generic successful-INITIAL proof rule.
                events=[events[0],events[1],events[-1],
                        {"kind":"harness-injected-wire-tamper","tamper":tamper,"commandId":"command-1","deploymentId":"deployment-1","correlationId":"correlation-1"},
                        {"kind":"receiver-rejection","commandId":"command-1","deploymentId":"deployment-1","correlationId":"correlation-1", "requestAuthenticated":tamper!="unsigned",
                         "reason":"agent authentication failed" if tamper=="unsigned" else "INITIAL immutable execution binding changed"},
                        {"kind":"api-response","action":"INITIAL","statusCode":502,"body":{"error":{"code":"DEPLOY_OUTCOME_UNKNOWN","correlationId":"correlation-1"}}}]
                resources=resources[-1:]
            values.append({"status":"PASS","physicalDocker":True,"postgres":False,"grantId":self.grant["grantId"],"owner":self.grant["owner"],
                           "projectId":self.grant["projectId"],"receiptFile":M["suites"]["docker"]["physicalCases"][index]["receiptFile"],"events":events,"resources":resources})
        for index, receipt in enumerate(values):
            if receipt["receiptFile"].startswith("A_H_R_"):
                fixture=FinalAhrAcceptanceGuards();fixture.grant=self.grant
                generated=fixture.outcome(recovered="RECOVERS_A" in receipt["receiptFile"],cached="CACHE_RECONCILES" in receipt["receiptFile"],base=values[0])
                generated["receiptFile"]=receipt["receiptFile"];values[index]=generated
                self.grant.update(images=generated["images"],imageConfigs={k:v["observed"]["id"] for k,v in fixture.journal()["derivedImages"].items()})
        return values
    def test_missing_stale_job_engine_duplicate_or_unproven_physical_evidence_is_rejected(self):
        for fault in ("missing","duplicate","wrong-job","wrong-engine","no-effects","no-proof","cleanup-blocked","widened-cap"):
            with self.subTest(fault=fault):
                receipts=self.receipts()
                if fault=="missing":receipts.pop()
                elif fault=="duplicate":receipts[-1]=copy.deepcopy(receipts[0])
                elif fault=="wrong-job":receipts[-1]["events"][0]["ciJob"]["runId"]="foreign"
                elif fault=="wrong-engine":receipts[-1]["events"][0]["engineId"]="foreign"
                elif fault=="no-effects":receipts[-1]["events"]=[e for e in receipts[-1]["events"] if e["kind"]!="docker-command"]
                elif fault=="no-proof":receipts[0]["events"][4]["body"]["data"]["deployment"].pop("executionReceipt")
                elif fault=="cleanup-blocked":receipts[-1]["events"]=[e for e in receipts[-1]["events"] if e["kind"]!="cleanup-receipt"]
                else:receipts[0]["events"][2]["memory"]=0
                self.assertFalse(H["verify_physical"](receipts,self.grant))
    def test_characterizes_distinct_raw_tamper_and_success_receipt_unit_fixtures(self):
        self.assertTrue(H["verify_physical"](self.receipts(),self.grant))
        for receipt in [value for value in self.receipts() if value["receiptFile"].startswith("WIRE_")]:
            self.assertEqual([r["kind"] for r in receipt["resources"]],["network"])
            self.assertEqual(next(e for e in receipt["events"] if e["kind"]=="api-response")["statusCode"],502)
    def test_characterizes_valid_declared_job_without_implicit_runtime_effects(self):
        self.assertEqual(H["validate_context"](self.grant,self.env,0),self.grant);self.assertEqual(self.fake.calls,[])
    def test_characterizes_private_empty_config_metadata_without_contents(self):
        self.assertIsNone(H["validate_config"]({"directory":True,"symlink":False,"owned":True,"mode":0o700},[]))
    def test_characterizes_reference_from_matching_observed_manifest_bytes_and_header(self):
        body=b'{"schemaVersion":2}';digest="sha256:"+hashlib.sha256(body).hexdigest();repository="127.0.0.1:49172/deploylite-p2/fixture"
        self.assertEqual(H["manifest_reference"](body,digest,repository),repository+"@"+digest)
    def test_characterizes_valid_owned_image_and_resource_observations_as_unit_inputs(self):
        expected={"reference":self.image()["repoDigests"][0],"platform":"linux/amd64","flavor":"a"}
        self.assertEqual(H["validate_image"](self.image(),expected),self.image())
        self.assertEqual(H["validate_owned_resource"](self.resource(),self.resource(),self.grant["bounds"]),self.resource())
    def test_characterizes_full_unique_73_title_report_without_physical_credit(self):
        self.assertTrue(self.verify(self.report()))
    def test_workflow_declares_one_native_owned_job_explicit_scope_and_always_cleanup(self):
        workflow=(Path(__file__).parents[2]/".github/workflows/baseline.yml").read_text()
        self.assertIn("  p2-docker-acceptance:\n",workflow)
        job=workflow.split("  p2-docker-acceptance:\n",1)[1].split("  baseline-gate:\n",1)[0]
        self.assertIn("runs-on: ubuntu-24.04",job)
        self.assertIn("DEPLOYLITE_DOCKER_RUNTIME_GRANT: P2_PHYSICAL_DOCKER_APPROVED",job)
        self.assertIn("p2-physical-acceptance.py prepare",job)
        self.assertIn("p2-physical-acceptance.py cleanup",job)
        self.assertIn("p2-physical-acceptance.py verify",job)
        self.assertIn("if: always()",job)
        self.assertNotIn("repository variable",job)
    def test_new_job_failure_or_skip_cannot_be_reported_as_a_passed_baseline_gate(self):
        workflow=(Path(__file__).parents[2]/".github/workflows/baseline.yml").read_text()
        gate=workflow.split("  baseline-gate:\n",1)[1]
        self.assertIn("p2-docker-acceptance",gate.split("    steps:",1)[0])
        self.assertIn("needs.p2-docker-acceptance.result == 'success'",gate)
        self.assertIn("--check p2-docker-acceptance:pass",gate)
        self.assertIn("success:success:success:success",gate)
    def test_neutral_recorded_boundaries_do_not_construct_a_native_process(self):
        with self.assertRaises(H["PhysicalError"]):
            H["run_effect"](["docker","info"],self.grant,None)
        self.assertEqual(self.fake.calls,[])

class CorrectivePhysicalGuards(unittest.TestCase):
    """H1–H3 only: source assertions; recorded processes and clocked sockets, never actual I/O."""
    setUp = ProspectivePhysicalGuards.setUp
    receipts = ProspectivePhysicalGuards.receipts
    resource = ProspectivePhysicalGuards.resource

    def test_native_tagged_dockerhub_pin_accepts_canonical_observed_repository_digest(self):
        digest = M["fixture"]["registry"].split("@", 1)[1]
        for alias in ("registry", "library/registry", "docker.io/library/registry", "index.docker.io/library/registry"):
            with self.subTest(alias=alias):
                info = {"repoDigests": [alias + "@" + digest], "os": "linux", "architecture": "amd64"}
                error = None
                try: H["validate_input_image"](info, M["fixture"]["registry"], "linux/amd64")
                except H["PhysicalError"] as caught: error = str(caught)
                self.assertIsNone(error, "a documented tagless DockerHub alias must retain the exact pinned repository/digest")

    def test_native_input_pin_rejects_foreign_repository_digest_and_platform(self):
        digest = M["fixture"]["registry"].split("@", 1)[1]
        for reference, os_name, arch in (("foreign@" + digest, "linux", "amd64"), ("registry@sha256:" + "e" * 64, "linux", "amd64"),
                                         ("foreign.example/library/registry@" + digest, "linux", "amd64"),
                                         (M["fixture"]["registry"], "windows", "amd64"), (M["fixture"]["registry"], "linux", "arm64")):
            with self.subTest(reference=reference, os=os_name, arch=arch):
                with self.assertRaises(H["PhysicalError"]):
                    H["validate_input_image"]({"repoDigests": [reference], "os": os_name, "architecture": arch}, M["fixture"]["registry"], "linux/amd64")

    def realistic_receipts(self):
        receipts = self.receipts()
        for receipt in [value for value in receipts if value["receiptFile"].startswith("WIRE_")]:
            event = next(e for e in receipt["events"] if e["kind"] == "api-response")
            event["body"]["error"]["message"] = "The agent rejected the deployment command"
        return receipts

    def test_actual_message_bearing_correlated_wire_rejections_are_accepted(self):
        self.assertTrue(H["verify_physical"](self.realistic_receipts(), self.grant))

    def test_message_bearing_wire_rejections_still_require_502_code_and_correlation(self):
        for fault in ("status", "code", "correlationId", "receiver-correlation"):
            with self.subTest(fault=fault):
                receipts = self.realistic_receipts()
                wire = next(value for value in receipts if value["receiptFile"].startswith("WIRE_signed-other-initial"))
                response = next(e for e in wire["events"] if e["kind"] == "api-response")
                if fault == "status": response["statusCode"] = 200
                elif fault == "receiver-correlation":
                    next(e for e in wire["events"] if e["kind"] == "receiver-rejection")["correlationId"] = "foreign"
                else: response["body"]["error"][fault] = "foreign"
                self.assertFalse(H["verify_physical"](receipts, self.grant))

    def inspection(self, image=False):
        grant = copy.deepcopy(self.grant)
        grant["expiresAtMs"] = 1200000
        owned = {**self.resource(), "containerPort": 5000}
        data = self.resource()
        for field in ("kind", "networkId", "hostIp", "hostPort", "labelsVerified"): data.pop(field)
        data.update(ports={"5000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "49172"}]}, networks={"owned": {"NetworkID": "f" * 64}})
        if image:
            data = {"id": IMAGE, "repoDigests": ["127.0.0.1:49172/deploylite-p2/fixture@sha256:" + "e" * 64], "os": "linux", "architecture": "amd64",
                    "user": "65532:65532", "command": ["/bin/busybox", "httpd", "-f", "-p", "8080", "-h", "/www"],
                    "health": {"Interval": 1000000000, "Timeout": 1000000000, "Test": ["CMD", "/bin/busybox", "wget", "-q", "-T", "1", "-Y", "off", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]}}
        fake = FakeBoundary()
        def run(argv, **options):
            fake.calls.append((argv, options)); fake.now += 2
            return {"returncode": 0, "stdout": json.dumps(data), "stderr": ""}
        fake.run = run
        coordinator = H["Coordinator"](grant, {"events": [], "resources": []}, Path("/recorded-no-files"), fake)
        return grant, owned, fake, coordinator

    def test_container_inspection_receives_only_original_preparation_time_and_fences_late_settlement(self):
        grant, owned, fake, coordinator = self.inspection()
        fake.now = 599
        error = None
        try: coordinator.container(owned)
        except H["PhysicalError"] as caught: error = str(caught)
        self.assertIsNotNone(error, "late inspection must remain unknown instead of returning a verified resource")
        self.assertLessEqual(fake.calls[0][1]["timeout"], 1)
        self.assertEqual(coordinator.preparation_deadline, 600)

    def test_no_container_inspection_can_start_after_original_preparation_deadline(self):
        grant, owned, fake, coordinator = self.inspection()
        fake.now = 601
        with self.assertRaises(H["PhysicalError"]): coordinator.container(owned)
        self.assertEqual(fake.calls, [])
        self.assertEqual(coordinator.preparation_deadline, 600)

    def test_raw_image_inspection_uses_remaining_original_preparation_budget(self):
        grant, owned, fake, coordinator = self.inspection(image=True)
        fake.now = 599
        error = None
        try: H["observe_image"]("127.0.0.1:49172/deploylite-p2/fixture@sha256:" + "e" * 64, grant, fake, deadline=600)
        except H["PhysicalError"] as caught: error = str(caught)
        self.assertIsNotNone(error)
        self.assertLessEqual(fake.calls[0][1]["timeout"], 1)

    def clocked_http(self, headers_drip, completes=False):
        from unittest.mock import patch
        class ClockedNetwork:
            def __init__(self):
                self.now = 0.0; self.socket_closed = False; self.socket_calls = 0
                header = b"HTTP/1.1 200 OK\r\nContent-Length: 2048\r\nDocker-Content-Digest: sha256:" + b"e" * 64 + b"\r\n\r\n"
                self.headers = [bytes([b]) for b in header] if headers_drip else [header]
                self.body = [b"x"] * 2048
                if completes:
                    payload = b'{"schemaVersion":2}'
                    self.headers = [b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(payload)).encode() + b"\r\nDocker-Content-Digest: sha256:" + b"e" * 64 + b"\r\n\r\n"]
                    self.body = [payload]
                self.packets = list(self.headers + self.body)
                self.ready_at = 0.1
            def open_socket(self, *args): self.socket_calls += 1; return self
            def setblocking(self, value): self.assert_nonblocking = value is False
            def connect_ex(self, address):
                if address != ("127.0.0.1", 49172): raise AssertionError("only exact loopback fixture endpoint")
                return 0
            def getsockopt(self, *args): return 0
            def send(self, data): return len(data)
            def recv(self, size):
                if not self.packets: return b""
                chunk = self.packets.pop(0)
                if len(chunk) > size: self.packets.insert(0, chunk[size:]); chunk = chunk[:size]
                self.ready_at = self.now + 0.1
                return chunk
            def wait(self, reads, writes, errors, timeout):
                if writes: return ([], writes, [])
                delay = max(0, self.ready_at - self.now)
                if timeout < delay: self.now += timeout; return ([], [], [])
                self.now += delay; return (reads, [], [])
            def close(self): self.socket_closed = True
            # Model v1's urllib buffered header/body calls: individual bytes arrive before
            # each socket timeout, but the full blocking read lasts beyond the total deadline.
            def open(self, request, timeout):
                self.now += len(self.headers) * 0.1; return self
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, maximum): self.now += len(self.body) * 0.1; return b"x" * min(maximum, 2048)
            @property
            def headers(self): return self._headers
            @headers.setter
            def headers(self, value): self._headers = value
        fake = ClockedNetwork()
        # urllib response headers normally expose .get; keep the buffered path's input valid.
        class BufferedResponse:
            headers = {"Docker-Content-Digest": "sha256:" + "e" * 64}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, maximum): return fake.read(maximum)
        class Opener:
            def open(self, request, timeout): fake.now += len(fake.headers) * 0.1; return BufferedResponse()
        with patch("urllib.request.build_opener", return_value=Opener()), patch("socket.socket", side_effect=fake.open_socket), patch("select.select", side_effect=fake.wait):
            error = None
            try: result = H["loopback_bytes"]("http://127.0.0.1:49172/v2/fixture/manifests/prepared", 4096, 10, clock=lambda: fake.now)
            except H["PhysicalError"] as caught: error = str(caught)
        if completes:
            self.assertIsNone(error, "a complete in-budget response must not be rejected by a blanket failure stub")
            self.assertEqual(result, (b'{"schemaVersion":2}', "sha256:" + "e" * 64))
            self.assertTrue(fake.socket_closed)
        else:
            self.assertIsNotNone(error, "a timed-out response must never become verified")
        self.assertLessEqual(fake.now, 10, "header/body drip must settle at the original deadline, without a new period or unbounded thread")
        return fake

    def test_characterizes_complete_in_budget_http_bytes_digest_and_socket_settlement(self):
        self.clocked_http(headers_drip=False, completes=True)

    def test_dripping_http_headers_settle_within_the_single_supplied_deadline(self):
        self.clocked_http(headers_drip=True)

    def test_dripping_http_body_settles_within_the_single_supplied_deadline(self):
        self.clocked_http(headers_drip=False)

class FinalAhrAcceptanceGuards(unittest.TestCase):
    """Final source guards only: no native subprocess, Docker, sockets or PostgreSQL."""
    setUp = ProspectivePhysicalGuards.setUp
    receipts = ProspectivePhysicalGuards.receipts

    def journal(self):
        return {"derivedImages": {flavor: {"reference": "127.0.0.1:49172/deploylite-p2/" + flavor + "@sha256:" + digest * 64,
            "observed": {"id": "sha256:" + config * 64, "repoDigests": ["127.0.0.1:49172/deploylite-p2/" + flavor + "@sha256:" + digest * 64], "platform": "linux/amd64", "flavor": flavor}}
            for flavor, digest, config in [("a", "e", "b"), ("h", "f", "c")]}}

    def harness(self, journal=None):
        return H["harness_manifest"](self.grant, journal or self.journal(), Path("/tmp/recorded-empty-config"), Path("/tmp/recorded-credentials.json"), Path("/tmp/recorded-receipts"), [], [])

    def test_requires_both_grant_pins_to_equal_independently_prepared_journal_image_identities(self):
        harness = self.harness()
        self.assertEqual(harness.get("images"), {k: v["reference"] for k, v in self.journal()["derivedImages"].items()})
        self.assertEqual(harness["image"], harness["images"]["a"])

    def outcome(self, recovered=False, cached=False, base=None):
        receipt = copy.deepcopy(base if base is not None else self.receipts()[0]); receipt["receiptFile"] = "A_H_R_PROOF_REPLAY_STOP.json"
        A, H_id, R = [str(i) * 8 + "-" + str(i) * 4 + "-4" + str(i) * 3 + "-8" + str(i) * 3 + "-" + str(i) * 12 for i in (3, 4, 5)]
        images = {k: v["reference"] for k,v in self.journal()["derivedImages"].items()}
        values = []
        for execution, image, physical, digest, origin, config in [(A, images["a"], "a"*64, "e", A, "b"), (H_id, images["h"], "b"*64, "f", H_id, "c"), (R, images["h"], "c"*64, "f", H_id, "c")]:
            proof = {"schemaVersion": 1, "candidateId": execution+":candidate:command", "deploymentId": execution, "projectId": receipt["projectId"], "runtimeHost": "22222222-2222-4222-8222-222222222222", "snapshotOriginId": origin, "snapshotHash": ("d" if origin==A else "c")*64, "effectiveImageDigest": "sha256:"+digest*64, "container": "deploylite-active-"+execution, "containerId": physical, "network": "p2v-fixture", "hostPort":49170,"containerPort":8080}
            value={"id":execution,"projectId":receipt["projectId"],"agentId":proof["runtimeHost"],"status":"succeeded","snapshotOriginId":origin,"snapshotHash":proof["snapshotHash"],"executionReceipt":proof}
            if execution==R:value.update(sourceDeploymentId=H_id,activeDeploymentId=A)
            values.append(value)
            receipt["events"].append({"kind":"physical-observation","deploymentId":execution,"observation":{"id":physical,"owner":receipt["owner"],"projectId":receipt["projectId"],"imageId":"sha256:"+config*64,"effectiveImage":image}})
            receipt["events"].append({"kind":"owned-container-budget","containerId":physical,"id":physical,"cpu":500000000,"memory":67108864,"pids":64})
            receipt["resources"].append({"kind":"container","id":physical,"owner":receipt["owner"],"project":receipt["projectId"]})
            receipt["events"].append({"kind":"cleanup-receipt","resource":"container","id":physical,"verifiedLabels":True,"removed":True})
        command={"id":"original-command","action":"deployment.rollback","status":"completed","correlationId":"original-correlation","executionAuthority":{"sourceLease":{"deploymentId":A}},"result":{"action":"deployment.rollback","commandId":"original-command","projectId":receipt["projectId"],"activeDeploymentId":A,"sourceDeploymentId":H_id,"deploymentId":R,"snapshotHash":values[1]["snapshotHash"],"imageReference":images["h"],"executionStatus":"succeeded","status":"completed"}}
        receipt.update(images=images, completionState={"deployments":values,"commands":[command]})
        receipt["events"][4]["body"]["data"]["deployment"]=copy.deepcopy(values[0])
        for flavor, image in images.items():receipt["events"].append({"kind":"fixture-image-observation","flavor":flavor,"imageReference":image,"imageId":self.journal()["derivedImages"][flavor]["observed"]["id"]})
        receipt["events"].append({"kind":"version-observation","deploymentId":A,"containerId":values[0]["executionReceipt"]["containerId"],"body":"deploylite-p2-fixture=A\n"})
        receipt["events"].append({"kind":"version-observation","deploymentId":R,"containerId":values[2]["executionReceipt"]["containerId"],"body":"deploylite-p2-fixture=H\n"})
        if recovered:
            receipt["receiptFile"]="A_H_R_POST_STOP_THROW_RECOVERS_A.json"
            values[2]["status"]="failed";values[2].pop("executionReceipt");command["result"]["executionStatus"]="failed"
            receipt["events"].append({"kind":"recovery-bracket","prior":A,"priorPhysicalId":values[0]["executionReceipt"]["containerId"],"upperBoundMs":100})
        if cached:
            receipt["receiptFile"]="A_H_R_LOST_REPLY_CACHE_RECONCILES_NO_EFFECTS.json"
            receipt["events"].append({"kind":"cached-receipt-reconciliation","commandId":"original-command","correlationId":"original-correlation","requestId":"fresh-request","before":{"docker":3,"dispatch":1,"claim":1,"wait":0,"release":0},"after":{"docker":3,"dispatch":1,"claim":1,"wait":0,"release":0}})
        return receipt

    def verified(self, receipt):
        from unittest.mock import patch
        with patch.dict(H["MANIFEST"]["suites"]["docker"], {"physicalCases":[{"receiptFile":receipt["receiptFile"]}]}):
            return H["verify_physical"]([receipt],{**self.grant, "images": {flavor: value["reference"] for flavor,value in self.journal()["derivedImages"].items()}, "imageConfigs": {flavor: value["observed"]["id"] for flavor,value in self.journal()["derivedImages"].items()}})

    def test_rejects_copied_A_evidence_for_H_even_when_labels_match(self):
        receipt=self.outcome();self.assertTrue(self.verified(receipt), "valid complete fixture before copied observation")
        observation=next(e for e in receipt["events"] if e["kind"]=="fixture-image-observation" and e["flavor"]=="h")
        observation["imageId"]=self.journal()["derivedImages"]["a"]["observed"]["id"]
        self.assertFalse(self.verified(receipt))

    def test_rejects_rollback_proof_or_command_evidence_that_swaps_active_A_and_historical_H(self):
        receipt=self.outcome();self.assertTrue(self.verified(receipt), "valid complete fixture before role tampering");command=receipt["completionState"]["commands"][0]
        command["result"]["sourceDeploymentId"]=command["result"]["activeDeploymentId"]
        self.assertFalse(self.verified(receipt))

    def test_requires_observed_exact_version_bodies_and_retained_physical_A_after_recovery(self):
        for field in ("physical_A", "version_H"):
            with self.subTest(field=field):
                receipt=self.outcome(recovered=field=="physical_A")
                self.assertTrue(self.verified(receipt), "valid complete fixture before independent tampering")
                if field=="physical_A":receipt["events"][-1]["priorPhysicalId"]="e"*64
                else:receipt["events"][-1]["body"]="deploylite-p2-fixture=A\n"
                self.assertFalse(self.verified(receipt))

    def test_rejects_cache_reconciliation_with_additional_dispatch_claim_wait_release_or_Docker_effect(self):
        for field in ("docker","dispatch","claim","wait","release"):
            with self.subTest(field=field):
                receipt=self.outcome(cached=True);self.assertTrue(self.verified(receipt), "valid complete cache fixture before count tampering");receipt["events"][-1]["after"][field]+=1
                self.assertFalse(self.verified(receipt))

    def test_retains_original_deadline_and_denies_expired_or_unidentified_cleanup_without_PASS(self):
        self.fake.now=61
        for closure in ({"kind":"recovery","deadline":121},{"kind":"cleanup","deadline":92,"ownedIds":[ID]}, {"kind":"cleanup","deadline":62,"ownedIds":[]}):
            with self.subTest(closure=closure):
                with self.assertRaises(H["PhysicalError"]):H["run_effect"](["docker","rm","--force",ID],self.grant,self.fake,closure)
        self.assertEqual(self.fake.calls,[])


class HostedPreparationFailureGuards(unittest.TestCase):
    setUp = ProspectivePhysicalGuards.setUp

    def coordinator(self, events=None, engine=None):
        journal = {"resources": [], "events": [] if events is None else events}
        self.fake.run = lambda argv, **options: {"returncode": 0, "stdout": json.dumps(engine or {"id": self.grant["engineId"], "os": "linux"}), "stderr": ""}
        coordinator = H["Coordinator"](self.grant, journal, Path("/unused-recorded-only"), self.fake)
        coordinator.save = lambda: None
        return coordinator, journal

    def test_preparation_network_supports_loopback_publication_without_host_or_shared_network(self):
        import ast
        source = ast.parse(Path(__file__).with_name("p2-physical-acceptance.py").read_text())
        prepare = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "prepare")
        create = next(node for node in ast.walk(prepare) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                      and node.func.attr == "command" and node.args and isinstance(node.args[0], ast.List)
                      and ast.literal_eval(ast.List(elts=node.args[0].elts[:3], ctx=ast.Load())) == ["docker", "network", "create"])
        argv = eval(compile(ast.Expression(create.args[0]), "<recorded-network-argv>", "eval"),
                    {"__builtins__": {}}, {"grant": self.grant, "network": {"name": "p2v-prep-owned"}})
        # Docker28 skips external-connectivity programming on --internal networks.
        self.assertNotIn("--internal", argv, "an internal-only endpoint cannot publish the required host loopback registry port")
        self.assertEqual(argv[argv.index("--driver") + 1], "bridge")
        self.assertIn("com.docker.network.bridge.host_binding_ipv4=127.0.0.1", argv)
        self.assertEqual(argv[-1], "p2v-prep-owned")
        self.assertIn("com.deploylite.owner=" + self.grant["owner"], argv)
        self.assertIn("com.deploylite.project=" + self.grant["projectId"], argv)
        self.assertNotIn("host", argv)
        self.assertEqual(self.fake.calls, [])

    def test_readiness_preserves_specific_failure_and_original_deadline(self):
        from unittest.mock import patch
        calls = []
        failure = H["PhysicalError"]("owned_http_200_required")
        def recorded_read(url, maximum, deadline):
            calls.append((url, maximum, deadline))
            self.fake.now = deadline
            raise failure
        replacements = {"loopback_bytes": recorded_read}
        with patch.dict(H["wait_loopback"].__globals__, replacements), patch("time.monotonic", lambda: self.fake.now):
            with self.assertRaisesRegex(H["PhysicalError"], "^owned_loopback_readiness_unverified$") as caught:
                H["wait_loopback"]("http://127.0.0.1:49172/v2/", 15)
        self.assertIs(caught.exception.__cause__, failure, "readiness must retain the observed failure without extending its deadline")
        self.assertEqual(calls, [("http://127.0.0.1:49172/v2/", 1048576, 15)])

    def test_cleanup_records_owned_state_only_after_identity_validation(self):
        coordinator, journal = self.coordinator()
        resource = {"id": ID, "kind": "registry"}
        state = {"running": False, "status": "exited", "exitCode": 2, "oomKilled": False}
        operations = []
        coordinator.container = lambda resource, closure: {"state": state}
        coordinator.command = lambda argv, closure: operations.append(argv)
        closure = {"kind": "cleanup", "deadline": 30, "originalDeadline": 30, "ownedIds": [ID]}
        coordinator.remove(resource, closure)
        observations = [event for event in journal["events"] if event.get("phase") == "owned-container-state-before-removal"]
        self.assertEqual([(event["id"], event["state"]) for event in observations], [(ID, state)])
        self.assertEqual(operations, [["docker", "rm", "--force", ID]])
        journal["events"].clear(); operations.clear()
        def rejected_identity(*args): raise H["PhysicalError"]("owned_identity_mismatch")
        coordinator.container = rejected_identity
        with self.assertRaises(H["PhysicalError"]): coordinator.remove(resource, closure)
        self.assertEqual(journal["events"], [], "unvalidated state must not be recorded as owned evidence")
        self.assertEqual(operations, [], "identity failure must prevent removal")

    def test_empty_owned_cleanup_observes_engine_without_authorizing_removal(self):
        from unittest.mock import patch
        coordinator, journal = self.coordinator()
        failure = None
        with patch.dict(H["Coordinator"].cleanup.__globals__, {"current_sources": lambda: self.grant["sourceHashes"]}):
            try: coordinator.cleanup()
            except H["PhysicalError"] as error: failure = error
        self.assertIsNone(failure, "empty recorded scope must permit only the selected readonly engine observation")
        self.assertEqual(journal["cleanupStatus"], "verified")
        self.assertEqual(journal["cleanupClosure"]["ownedIds"], [])
        self.assertEqual(journal["cleanupClosure"]["deadline"], journal["cleanupClosure"]["originalDeadline"])

    def test_empty_cleanup_does_not_admit_effects_variants_missing_scope_or_renewed_deadline(self):
        closure = {"kind": "cleanup", "deadline": 30, "originalDeadline": 30, "ownedIds": []}
        for argv in (["docker", "rm", "--force", ID], ["docker", "pull", M["fixture"]["registry"]],
                     ["docker", "info"], ["docker", "info", "--format", "foreign"]):
            with self.subTest(argv=argv), self.assertRaises(H["PhysicalError"]):
                H["run_effect"](argv, self.grant, self.fake, copy.deepcopy(closure))
        selected = ["docker", "info", "--format", H["ENGINE_FORMAT"]]
        for invalid in ({key: value for key, value in closure.items() if key != "ownedIds"},
                        {**closure, "deadline": 31}, {**closure, "originalDeadline": 29}):
            with self.subTest(closure=invalid), self.assertRaises(H["PhysicalError"]):
                H["run_effect"](selected, self.grant, self.fake, invalid)
        self.assertEqual(self.fake.calls, [])

    def test_empty_cleanup_keeps_unknown_for_foreign_engine_or_unsettled_intent(self):
        from unittest.mock import patch
        for events, engine in (([], {"id": "foreign-engine", "os": "linux"}),
                               ([{"phase": "intent", "argv": ["docker", "network", "create", "recorded"]}], None)):
            with self.subTest(events=events, engine=engine):
                coordinator, journal = self.coordinator(events, engine)
                with patch.dict(H["Coordinator"].cleanup.__globals__, {"current_sources": lambda: self.grant["sourceHashes"]}):
                    with self.assertRaises(H["PhysicalError"]): coordinator.cleanup()
                self.assertEqual(journal["cleanupStatus"], "UNKNOWN")

    def test_preparation_retains_primary_failure_when_its_cleanup_also_fails(self):
        from unittest.mock import patch
        captured = []
        class RecordedCoordinator:
            def __init__(self, grant, journal, *args): self.journal = journal; captured.append(journal)
            def save(self): pass
            def command(self, *args): raise ValueError("recorded primary preparation failure")
            def cleanup(self): raise H["PhysicalError"]("recorded cleanup failure")
        self.fake.wall_ms = 0
        self.fake.run = lambda argv, **options: {"returncode": 0, "stdout": json.dumps({"id": self.grant["engineId"], "os": "linux", "architecture": "amd64"}), "stderr": ""}
        runner = Path("/unused-recorded-runner")
        inputs = {**self.env, "DOCKER_CONFIG": str(runner / "deploylite-p2-empty-docker-config")}
        replacements = {"validate_native_inputs": lambda env: runner, "preparation_root": lambda *args, **kwargs: runner / "deploylite-p2-docker-evidence",
                        "private_directory": lambda *args, **kwargs: None, "inspect_config": lambda env: None,
                        "current_sources": lambda: self.grant["sourceHashes"], "harness_contract": lambda: ([], []),
                        "NativeBoundary": lambda: self.fake, "write_private": lambda *args, **kwargs: None, "Coordinator": RecordedCoordinator}
        failure = None
        with patch.dict(H["prepare"].__globals__, replacements):
            try: H["prepare"](inputs)
            except Exception as error: failure = error
        self.assertIsInstance(failure, ValueError, "cleanup must not replace the original preparation exception")
        self.assertEqual(str(failure), "recorded primary preparation failure")
        self.assertEqual(captured[0]["primaryFailure"], {"type": "ValueError", "message": str(failure)})
        self.assertEqual(captured[0]["cleanupFailure"], {"type": "PhysicalError", "message": "recorded cleanup failure"})

if __name__ == "__main__":
    unittest.main(verbosity=2)
