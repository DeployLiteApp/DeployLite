import {expect,it} from "vitest";
import {browserDeletionRecoveryFailure,validateBrowserProof,validateDeletionBrowserProof} from "./p5-browser-proof.js";
function proof(){return {sourceCommit:"7e4875341dbb8e1afdeff23137403528f3af6382",engine:"postgres",projectId:"project1",databaseId:"orders",creation:"passed",selection:"passed",reload:"passed",telemetry:"passed",start:"passed",stop:"passed",persistence:"passed",browser:"chromium",context:"isolated",requests:12};}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts complete %s browser evidence",engine=>{expect(validateBrowserProof({...proof(),engine})).toBe(true);});
it("refuses missing stages, fabricated source, shared browser and unbounded evidence",()=>{
 for(const patch of [{start:"skipped"},{creation:"pending"},{sourceCommit:"main"},{context:"shared"},{requests:0},{requests:1001},{password:"private"},{engine:"sqlite"}])expect(validateBrowserProof({...proof(),...patch})).toBe(false);
 for(const key of Object.keys(proof())){const value:Record<string,unknown>={...proof()};delete value[key];expect(validateBrowserProof(value)).toBe(false);}
});


// A compatible call boundary exercises the new argument without claiming a type error as RED.
const validateCurrent:(value:unknown,expectedSource?:string)=>boolean=validateBrowserProof;
it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts exact bound current-source %s browser evidence",engine=>{
 const current="a".repeat(40);expect(validateCurrent({...proof(),engine,sourceCommit:current},current)).toBe(true);
});
it("rejects detached or invalid expected browser source while retaining historical default compatibility",()=>{
 expect(validateCurrent(proof(),"a".repeat(40))).toBe(false);
 for(const expected of ["","main","A".repeat(40)])expect(validateCurrent(proof(),expected)).toBe(false);
 expect(validateCurrent({...proof(),sourceCommit:"a".repeat(40)},undefined)).toBe(false);
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
