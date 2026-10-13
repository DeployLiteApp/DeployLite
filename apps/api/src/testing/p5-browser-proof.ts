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
