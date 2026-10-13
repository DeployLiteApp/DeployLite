import type {Clock} from "@deploylite/contracts";
import {awaitAbortable} from "@deploylite/domain";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
import type {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
type Verifier = ReturnType<typeof createManagedDatabaseReadinessVerifier>;
type Input = Parameters<Verifier["verifyStopped"]>[0];
type Resources = Parameters<Verifier["verifyStopped"]>[1];
type Authority = Parameters<Verifier["verifyStopped"]>[2];
function fail(): never {throw new Error("Database daemon removal is unavailable.");}
/** One non-forced removal after stopped admission; original persistent resources must remain. */
export function createManagedDatabaseDaemonRemover(supplied: Readonly<{
  runner: DockerCliRunner; verifier: Pick<Verifier,"verifyStopped"|"verifyRetained">; clock: Clock;
  limits: Readonly<{deadlineMs: number; maxOutputBytes: number}>;
}>) {
  const limits={...supplied.limits}, clock=supplied.clock;
  const run=supplied.runner.run.bind(supplied.runner), stopped=supplied.verifier.verifyStopped.bind(supplied.verifier), retained=supplied.verifier.verifyRetained.bind(supplied.verifier);
  if (!Number.isSafeInteger(limits.deadlineMs) || limits.deadlineMs<1 || limits.deadlineMs>60000
    || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes<1 || limits.maxOutputBytes>1048576) fail();
  return {async remove(raw: Input, resources: Resources, authority: Authority, external: AbortSignal): Promise<Readonly<{containerId: string; storage: "retained"}>> {
    const controller=new AbortController(), cancel=()=>controller.abort(); external.addEventListener("abort",cancel,{once:true});
    const timer=setTimeout(cancel,limits.deadlineMs);
    try {
      const input=structuredClone(raw), original=structuredClone(resources), start=clock.now();
      if (!Number.isSafeInteger(start) || start<0 || !/^[a-f0-9]{64}$/.test(input.containerId) || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)) fail();
      function current() {const now=clock.now(); if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now<start || now-start>=limits.deadlineMs) fail();}
      async function call<T>(work:()=>Promise<T>) {current(); const value=await awaitAbortable(work,controller.signal); current(); return value;}
      function valid(reply: Awaited<ReturnType<DockerCliRunner["run"]>>) {
        if (reply.exitCode!==0 || reply.signal!==null || Buffer.byteLength(reply.stdout)+Buffer.byteLength(reply.stderr)>limits.maxOutputBytes) fail();
      }
      await call(()=>authority.assertValid());
      const admitted=await call(()=>stopped(input,original,authority,controller.signal)); if (admitted.containerId!==input.containerId) fail();
      await call(()=>authority.assertValid());
      const removed=await call(()=>run(Object.freeze(["docker","rm",input.containerId]),controller.signal)); valid(removed);
      if (!new RegExp("^"+input.containerId+"\\n?$").test(removed.stdout)) fail();
      const absent=await call(()=>run(Object.freeze(["docker","container","ls","--all","--no-trunc","--filter",`id=${input.containerId}`,"--format","{{.ID}}"]),controller.signal)); valid(absent);
      if (absent.stdout!=="") fail();
      const verified=await call(()=>retained(input,original,authority,controller.signal)); if (verified.containerId!==input.containerId) fail();
      await call(()=>authority.assertValid());
      return Object.freeze({containerId:input.containerId,storage:"retained" as const});
    } catch {return fail();}
    finally {clearTimeout(timer); external.removeEventListener("abort",cancel);}
  }};
}
