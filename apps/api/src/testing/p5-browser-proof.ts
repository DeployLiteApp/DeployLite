import {z} from "zod";
export const browserSourceCommit="7e4875341dbb8e1afdeff23137403528f3af6382";
const passed=z.literal("passed");
const schema=z.object({sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),engine:z.enum(["postgres","mysql","mariadb","mongodb","redis"]),
 projectId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),databaseId:z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
 creation:passed,selection:passed,reload:passed,telemetry:passed,start:passed,stop:passed,persistence:passed,
 browser:z.literal("chromium"),context:z.literal("isolated"),requests:z.number().int().min(1).max(1000)}).strict();
export function validateBrowserProof(value:unknown,expectedSource=browserSourceCommit):boolean {
 const parsed=schema.safeParse(value);
 return /^[a-f0-9]{40}$/.test(expectedSource)&&parsed.success&&parsed.data.sourceCommit===expectedSource;
}

const deletionSchema=schema.pick({sourceCommit:true,engine:true,projectId:true,databaseId:true,browser:true,context:true,requests:true}).extend({
 preparation:passed,confirmation:passed,recovery:passed,sameOriginalKey:passed,inventory:passed,reload:passed,retainedStorage:passed
}).strict();
export function validateDeletionBrowserProof(value:unknown,expectedSource:string):boolean{
 const parsed=deletionSchema.safeParse(value);
 return /^[a-f0-9]{40}$/.test(expectedSource)&&parsed.success&&parsed.data.sourceCommit===expectedSource;
}

export type BrowserDeletionRecoveryObservation = Readonly<{
 calls: readonly Readonly<{key:string;confirmationId:string;status:number}>[];
 key:string; confirmationId:string; failures:readonly ("request"|"application"|"foreign")[];
}>;
/** Fixed metadata only; never reflect keys, nonce identifiers or browser diagnostics. */
export function browserDeletionRecoveryFailure(value:BrowserDeletionRecoveryObservation):string|null {
 if(value.calls.length!==2)return "count";
 if(value.calls[0]!.status!==503||value.calls[1]!.status!==200)return "status";
 if(value.calls.some(call=>call.key!==value.key))return "key";
 if(value.calls.some(call=>call.confirmationId!==value.confirmationId))return "confirmation";
 for(const kind of ["foreign","application","request"] as const)if(value.failures.includes(kind))return kind;
 return null;
}
