import {expect,it} from "vitest";
import {validateBrowserProof} from "./p5-browser-proof.js";
function proof(){return {sourceCommit:"7e4875341dbb8e1afdeff23137403528f3af6382",engine:"postgres",projectId:"project1",databaseId:"orders",creation:"passed",selection:"passed",reload:"passed",telemetry:"passed",start:"passed",stop:"passed",persistence:"passed",browser:"chromium",context:"isolated",requests:12};}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("accepts complete %s browser evidence",engine=>{expect(validateBrowserProof({...proof(),engine})).toBe(true);});
it("refuses missing stages, fabricated source, shared browser and unbounded evidence",()=>{
 for(const patch of [{start:"skipped"},{creation:"pending"},{sourceCommit:"main"},{context:"shared"},{requests:0},{requests:1001},{password:"private"},{engine:"sqlite"}])expect(validateBrowserProof({...proof(),...patch})).toBe(false);
 for(const key of Object.keys(proof())){const value:Record<string,unknown>={...proof()};delete value[key];expect(validateBrowserProof(value)).toBe(false);}
});
