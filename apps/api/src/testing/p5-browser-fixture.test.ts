import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {FastifyInstance} from "fastify";
import {openDatabaseBrowser} from "./p5-browser-fixture.js";

const current="a".repeat(40);
const platform=Object.getOwnPropertyDescriptor(process,"platform")!;
const boundary=vi.hoisted(()=>({
 git:vi.fn(),build:vi.fn(),server:vi.fn(),launch:vi.fn(),inject:vi.fn(),
 postcss:vi.fn(),tailwind:vi.fn(),processStyles:vi.fn(),readStyles:vi.fn(),
 contextClose:vi.fn(),browserClose:vi.fn(),serverClose:vi.fn(),
 request:undefined as undefined|((request:object,response:object)=>Promise<void>)
}));

vi.mock("node:child_process",()=>({execFileSync:boundary.git}));
vi.mock("node:http",()=>({createServer:boundary.server}));
vi.mock("node:fs/promises",()=>({readFile:boundary.readStyles}));
vi.mock("node:module",()=>({createRequire:()=>Object.assign((name:string)=>{
 if(name==="esbuild")return {build:boundary.build};
 if(name==="postcss")return boundary.postcss;
 if(name==="@tailwindcss/postcss")return boundary.tailwind;
 throw new Error("Unexpected mocked compiler dependency.");
},{resolve:(name:string)=>name})}));
// The existing proof module carries the mock browser export; its real validator is retained.
vi.mock("node:url",()=>({pathToFileURL:()=>({href:"./p5-browser-proof.js"})}));
vi.mock("./p5-browser-proof.js",async importOriginal=>({
 ...await importOriginal<typeof import("./p5-browser-proof.js")>(),
 chromium:{launch:boundary.launch}
}));

beforeEach(()=>{
 vi.clearAllMocks();
 Object.defineProperty(process,"platform",{...platform,value:"linux"});
 for(const [name,value] of Object.entries({GITHUB_ACTIONS:"true",RUNNER_ENVIRONMENT:"github-hosted",
  GITHUB_JOB:"p5-native-operator-acceptance",DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT:"P5_OPERATOR_CI_APPROVED",
  DEPLOYLITE_P5_EXPECTED_SHA:current,RUNNER_TEMP:"/scoped-runner-temp",
  DEPLOYLITE_P5_BROWSER_LIBRARY:"/scoped-runner-temp/deploylite-p5-browser-tooling/node_modules/playwright/index.mjs"}))vi.stubEnv(name,value);
 boundary.git.mockImplementation((_command:string,args:string[])=>args[0]==="rev-parse"?current+"\n":"");
 boundary.build.mockResolvedValue({outputFiles:[{text:"/* mocked bundle */"}]});
 boundary.tailwind.mockReturnValue({postcssPlugin:"mock-tailwind"});
 boundary.postcss.mockReturnValue({process:boundary.processStyles});
 boundary.readStyles.mockResolvedValue("/* mocked globals */");
 boundary.processStyles.mockResolvedValue({css:"/* mocked styles */"});
 boundary.inject.mockResolvedValue({statusCode:200,body:"{}",json:()=>({})});
 boundary.server.mockImplementation((request:typeof boundary.request)=>{
  boundary.request=request;
  return {once:vi.fn(),listen:(_port:number,_host:string,done:()=>void)=>done(),
   address:()=>({port:40001}),closeAllConnections:vi.fn(),
   close:boundary.serverClose.mockImplementation((done:()=>void)=>done())};
 });
 const locator={waitFor:vi.fn(),click:vi.fn(),fill:vi.fn(),selectOption:vi.fn(),isDisabled:async()=>true};
 const page={setDefaultTimeout:vi.fn(),on:vi.fn(),route:vi.fn(),reload:vi.fn(),waitForFunction:vi.fn(),
  getByRole:()=>locator,getByLabel:()=>locator,getByText:()=>locator,
  goto:async(url:string)=>{
   if(url!=="about:blank")await boundary.request!({url:"/api/v1/projects/project1/databases",method:"GET",headers:{},
    async *[Symbol.asyncIterator](){}},{setHeader:vi.fn(),writeHead:vi.fn(),end:vi.fn()});
  }};
 boundary.launch.mockResolvedValue({newContext:async()=>({newPage:async()=>page,close:boundary.contextClose}),close:boundary.browserClose});
});
afterEach(()=>{
 vi.unstubAllEnvs();
 Object.defineProperty(process,"platform",platform);
});

function input(sourceCommit=current){
 // A variable with an extra property remains type-safe against the original pre-binding input.
 const value:Parameters<typeof openDatabaseBrowser>[0]&{sourceCommit:string}={sourceCommit,
  projectId:"project1",databaseId:"orders",engine:"postgres",cookie:"fixture-cookie",
  app:()=>({inject:boundary.inject}) as unknown as FastifyInstance};
 return value;
}

it("opens and closes the unchanged fixture using only mocked effect ports",async()=>{
 const fixture=await openDatabaseBrowser(input());
 try{
  const proof=await fixture.cycle(async()=>{});
  expect(proof.browser).toBe("chromium");
  expect(proof.requests).toBeGreaterThan(0);
  expect(boundary.inject).toHaveBeenCalledWith(expect.objectContaining({headers:{cookie:"fixture-cookie"}}));
  expect(boundary.build).toHaveBeenCalledTimes(1);
  expect(boundary.tailwind).toHaveBeenCalledWith({base:expect.stringMatching(/apps\/web$/)});
  expect(boundary.postcss).toHaveBeenCalledWith([{postcssPlugin:"mock-tailwind"}]);
  expect(boundary.readStyles).toHaveBeenCalledWith(expect.stringMatching(/globals\.css$/),"utf8");
  expect(boundary.processStyles).toHaveBeenCalledWith("/* mocked globals */",{from:expect.stringMatching(/globals\.css$/)});
  expect(boundary.server).toHaveBeenCalledTimes(1);
  expect(boundary.launch).toHaveBeenCalledTimes(1);
 }finally{await fixture.close();}
 expect(boundary.contextClose).toHaveBeenCalledTimes(1);
 expect(boundary.browserClose).toHaveBeenCalledTimes(1);
 expect(boundary.serverClose).toHaveBeenCalledTimes(1);
});

async function expectAdmissionBeforeEffects(value:ReturnType<typeof input>){
 const result=await openDatabaseBrowser(value).then(fixture=>({fixture}),error=>({error}));
 if("fixture" in result)await result.fixture.close();
 expect(boundary.build).not.toHaveBeenCalled();
 expect(boundary.tailwind).not.toHaveBeenCalled();
 expect(boundary.postcss).not.toHaveBeenCalled();
 expect(boundary.readStyles).not.toHaveBeenCalled();
 expect(boundary.processStyles).not.toHaveBeenCalled();
 expect(boundary.server).not.toHaveBeenCalled();
 expect(boundary.launch).not.toHaveBeenCalled();
 expect(result).toHaveProperty("error",expect.any(Error));
}

it.each(["","main","A".repeat(40)])("rejects malformed source %s before compiler, loopback or browser",async source=>{
 await expectAdmissionBeforeEffects(input(source));
});
it("rejects a source detached from the expected hosted SHA before effect ports",async()=>{
 vi.stubEnv("DEPLOYLITE_P5_EXPECTED_SHA","b".repeat(40));
 await expectAdmissionBeforeEffects(input());
});
it("rejects a source detached from current HEAD before effect ports",async()=>{
 boundary.git.mockImplementation((_command:string,args:string[])=>args[0]==="rev-parse"?"b".repeat(40)+"\n":"");
 await expectAdmissionBeforeEffects(input());
});
it("retains rejection of dirty tracked web or contracts before effect ports",async()=>{
 boundary.git.mockImplementation((_command:string,args:string[])=>args[0]==="rev-parse"?current+"\n":"apps/web/src/components/managed-database-telemetry-panel.tsx\n");
 await expectAdmissionBeforeEffects(input());
});
it("admits preserved lateral frontend against supplied current HEAD instead of the historical pin",async()=>{
 boundary.git.mockImplementation((_command:string,args:string[])=>args[0]==="rev-parse"?current+"\n":
  args[2]===current?"":"apps/web/src/components/managed-database-telemetry-panel.tsx\n");
 const result=await openDatabaseBrowser(input()).then(fixture=>({fixture}),error=>({error}));
 try{
  expect(result).toHaveProperty("fixture");
  expect(boundary.git).toHaveBeenCalledWith("git",["rev-parse","HEAD"],expect.any(Object));
  expect(boundary.git).toHaveBeenCalledWith("git",["diff","--name-only",current,"--","apps/web","packages/contracts"],expect.any(Object));
 }finally{if("fixture" in result)await result.fixture.close();}
});
it("returns the supplied current source in strict browser proof",async()=>{
 const fixture=await openDatabaseBrowser(input());
 try{expect((await fixture.cycle(async()=>{})).sourceCommit).toBe(current);}
 finally{await fixture.close();}
});
