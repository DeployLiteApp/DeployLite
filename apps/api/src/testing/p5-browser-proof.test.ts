import {expect,it} from "vitest";
import {browserFixtureRequestFailure,browserDeletionRecoveryFailure,validateBrowserProof,validateDeletionBrowserProof} from "./p5-browser-proof.js";
function proof(){return {sourceCommit:"7e4875341dbb8e1afdeff23137403528f3af6382",engine:"postgres",projectId:"project1",databaseId:"orders",creation:"passed",selection:"passed",reload:"passed",telemetry:"passed",start:"passed",stop:"passed",persistence:"passed",browser:"chromium",context:"isolated",requests:12};}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts complete %s browser evidence",engine=>{expect(validateBrowserProof({...proof(),engine})).toBe(true);});
it("refuses missing stages, fabricated source, shared browser and unbounded evidence",()=>{
 for(const patch of [{start:"skipped"},{creation:"pending"},{sourceCommit:"main"},{context:"shared"},{requests:0},{requests:1001},{password:"private"},{engine:"sqlite"}])expect(validateBrowserProof({...proof(),...patch})).toBe(false);
 for(const key of Object.keys(proof())){const value:Record<string,unknown>={...proof()};delete value[key];expect(validateBrowserProof(value)).toBe(false);}
});

it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts exact bound current-source %s browser evidence",engine=>{
 const current="a".repeat(40);expect(validateBrowserProof({...proof(),engine,sourceCommit:current},current)).toBe(true);
});
it("rejects a valid-looking browser snapshot detached from the supplied exact source",()=>{
 expect(validateBrowserProof(proof(),"a".repeat(40))).toBe(false);
 for(const expected of ["","main","A".repeat(40)])expect(validateBrowserProof(proof(),expected)).toBe(false);
});

function deletionProof(){return {sourceCommit:"a".repeat(40),engine:"postgres",projectId:"project1",databaseId:"orders",browser:"chromium",context:"isolated",preparation:"passed",confirmation:"passed",recovery:"passed",sameOriginalKey:"passed",inventory:"passed",reload:"passed",retainedStorage:"passed",requests:7};}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts exact current %s destructive browser recovery",engine=>{expect(validateDeletionBrowserProof({...deletionProof(),engine},"a".repeat(40))).toBe(true);});
it("refuses missing deletion stages, foreign source, skipped recovery and shared browser",()=>{
  const proof=deletionProof();for(const key of Object.keys(proof)){const value:Record<string,unknown>={...proof};delete value[key];expect(validateDeletionBrowserProof(value,"a".repeat(40))).toBe(false);}
  for(const patch of [{sourceCommit:"b".repeat(40)},{recovery:"skipped"},{requests:0},{requests:1001},{context:"shared"},{password:"private"}])expect(validateDeletionBrowserProof({...proof,...patch},"a".repeat(40))).toBe(false);
});


it("compiles current Workbench CSS including modal stacking before browser acceptance",async()=>{
 const fixture=await import("./p5-browser-fixture.js");
 expect(fixture).toHaveProperty("buildDatabaseBrowserStyles");
 const css=await fixture.buildDatabaseBrowserStyles();
 expect(css).toContain("position: fixed");expect(css).toContain("z-index: 50");
 expect(css).toContain(".left-1\\/2");expect(css).not.toContain('@import "tailwindcss"');
});

function recoveryObservation(){return {calls:[{key:"original-key",confirmationId:"original-nonce",status:503},{key:"original-key",confirmationId:"original-nonce",status:200}],key:"original-key",confirmationId:"original-nonce",failures:[] as ("request"|"application"|"foreign")[]};}
it("accepts exactly the original uncertain call and successful recovery without browser failures",()=>{expect(browserDeletionRecoveryFailure(recoveryObservation())).toBeNull();});
it.each(["count","status","key","confirmation","request","application","foreign"] as const)("classifies refused browser recovery as fixed %s metadata",kind=>{
 const value=recoveryObservation();if(kind==="count")value.calls.pop();else if(kind==="status")value.calls[1]!.status=503;
 else if(kind==="key")value.calls[1]!.key="private-key-fixture";else if(kind==="confirmation")value.calls[1]!.confirmationId="private-nonce-fixture";else value.failures.push(kind);
 expect(browserDeletionRecoveryFailure(value)).toBe(kind);expect(browserDeletionRecoveryFailure(value)).not.toContain("private-");
});

it.each(["routing","body","inject","projection","response"] as const)("identifies fixed request %s failure without reflecting diagnostics",stage=>{expect(browserFixtureRequestFailure({stage,aborted:false,code:"password=private-fixture"})).toBe(stage);});
it("identifies body cancellation without accepting or ignoring the failed request",()=>{expect(browserFixtureRequestFailure({stage:"body",aborted:true,code:"ECONNRESET"})).toBe("body-aborted");});
it("identifies closed owned API admission without reflecting source",()=>{expect(browserFixtureRequestFailure({stage:"inject",aborted:false,code:"FST_ERR_REOPENED_CLOSE_SERVER"})).toBe("api-closed");});
it("keeps unknown request metadata redacted",()=>{expect(browserFixtureRequestFailure({stage:"password=private-fixture",aborted:false,code:"private-path"} as never)).toBe("request");});
it("preserves request rejection with bounded stage metadata",()=>{expect(browserDeletionRecoveryFailure({calls:[{key:"key",confirmationId:"nonce",status:503},{key:"key",confirmationId:"nonce",status:200}],key:"key",confirmationId:"nonce",failures:["request"],requestFailure:"body-aborted"})).toBe("request:body-aborted");});
it("identifies a temporarily missing owned application separately from injection",()=>{expect(browserFixtureRequestFailure({stage:"app",aborted:false,code:undefined})).toBe("app");});

function backupProof(engine="postgres") {return {sourceCommit:"a".repeat(40),engine,projectId:"project1",databaseId:"orders",actorId:"operator1",browser:"chromium",context:"isolated",requests:12,commandId:"backup1",originalCommandId:"create1",archiveId:"backup_"+"a".repeat(32),idempotencyKey:"original-key",destinationId:"private-native",manual:"passed",originalSource:"passed",lostReply:"passed",reload:"passed",sameOriginalKey:"passed",inventory:"passed",calls:[{key:"original-key",commandId:"backup1",archiveId:"backup_"+"a".repeat(32),actorId:"operator1",status:200},{key:"original-key",commandId:"backup1",archiveId:"backup_"+"a".repeat(32),actorId:"operator1",status:200}]};}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("requires complete original %s manual backup browser evidence",async engine=>{const {validateBackupBrowserProof}=await import("./p5-browser-proof.js");expect(validateBackupBrowserProof(backupProof(engine),"a".repeat(40))).toBe(true);});

it("rejects incomplete detached foreign-source or private native backup browser evidence",async()=>{
 const {validateBackupBrowserProof}=await import("./p5-browser-proof.js");
 for(const patch of [{manual:"pending"},{reload:"skipped"},{sourceCommit:"b".repeat(40)},{context:"shared"},{privatePath:"private"},{calls:[]},{commandId:"create1"}])expect(validateBackupBrowserProof({...backupProof(),...patch},"a".repeat(40))).toBe(false);
 for(const field of ["key","commandId","archiveId","actorId"] as const){const value=backupProof();value.calls[1]![field]="foreign";expect(validateBackupBrowserProof(value,"a".repeat(40))).toBe(false);}
});
