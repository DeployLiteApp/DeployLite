/** Hosted acceptance only: isolated Chromium and same-source React; no module-load services. */
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import type {FastifyInstance} from "fastify";
import {validateBrowserProof} from "./p5-browser-proof.js";
const root=resolve(import.meta.dirname,"../../../..");
/** Browser library types are isolated CI tooling, not a production dependency. */
export async function openDatabaseBrowser(input:{sourceCommit:string;projectId:string;databaseId:string;engine:string;cookie:string;app():FastifyInstance}) {
 if(process.platform!=="linux"||process.env.GITHUB_ACTIONS!=="true"||process.env.RUNNER_ENVIRONMENT!=="github-hosted"
  ||process.env.GITHUB_JOB!=="p5-native-operator-acceptance"||process.env.DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT!=="P5_OPERATOR_CI_APPROVED")throw new Error("Hosted browser admission required.");
 const sourceCommit=input.sourceCommit;
 if(!/^[a-f0-9]{40}$/.test(sourceCommit)||sourceCommit!==process.env.DEPLOYLITE_P5_EXPECTED_SHA
  ||execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()!==sourceCommit
  ||execFileSync("git",["diff","--name-only",sourceCommit,"--","apps/web","packages/contracts"],{cwd:root,encoding:"utf8"}).trim())throw new Error("Browser must exercise exact bound current source.");
 const library=process.env.DEPLOYLITE_P5_BROWSER_LIBRARY;
 if(!library||library!==resolve(process.env.RUNNER_TEMP!,"deploylite-p5-browser-tooling/node_modules/playwright/index.mjs"))throw new Error("Scoped browser tooling required.");
 const require=createRequire(import.meta.url),viteRequire=createRequire(createRequire(require.resolve("vitest/package.json")).resolve("vite")),esbuild=viteRequire("esbuild");
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {ManagedDatabaseWorkbench} from './apps/web/src/components/managed-database-workbench';createRoot(document.getElementById('root')).render(React.createElement(ManagedDatabaseWorkbench,{projectId:${JSON.stringify(input.projectId)},apiBaseUrl:location.origin}));`;
 const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",
  alias:{"@":resolve(root,"apps/web/src"),"@deploylite/contracts":resolve(root,"packages/contracts/src/index.ts")},nodePaths:[resolve(root,"apps/web/node_modules")],define:{"process.env.NODE_ENV":'"production"'}});
 const script=bundle.outputFiles[0].text;
 let requests=0,applyResponse:{statusCode:number;json():any}|undefined;
 const failures:Error[]=[];
 const server=createServer(async(req,res)=>{
  try{
   if(req.url==="/"&&req.method==="GET"){res.setHeader("Content-Type","text/html");res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');return;}
   if(req.url==="/fixture.js"&&req.method==="GET"){res.setHeader("Content-Type","application/javascript");res.end(script);return;}
   if(req.url==="/favicon.ico"){res.writeHead(204);res.end();return;}
   const prefix=`/api/v1/projects/${input.projectId}/databases`;
   if(!req.url?.startsWith(prefix)||!['GET','POST'].includes(req.method!))throw new Error("Unscoped browser API request.");
   let bytes="";for await(const chunk of req){bytes+=chunk;if(Buffer.byteLength(bytes)>131072)throw new Error("Bounded browser request required.");}
   if(++requests>1000)throw new Error("Bounded browser request count required.");
   const headers:{cookie:string;"idempotency-key"?:string}={cookie:input.cookie};
   if(typeof req.headers['idempotency-key']==='string')headers['idempotency-key']=req.headers['idempotency-key'];
   const response=await input.app().inject({method:req.method as 'GET'|'POST',url:req.url,headers,...(bytes?{payload:JSON.parse(bytes)}:{})});
   if(req.url===prefix+`/${input.databaseId}/runtime/apply`&&response.statusCode===200)applyResponse=response;
   res.writeHead(response.statusCode,{"Content-Type":"application/json"});res.end(response.body);
  }catch{failures.push(new Error("Browser fixture request failed."));res.writeHead(500);res.end('{"error":"Fixture unavailable"}');}
 });
 let browser:any,context:any,page:any;
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const address=server.address();if(!address||typeof address==='string')throw new Error("Ephemeral loopback required.");
 const origin=`http://127.0.0.1:${address.port}`;
 try{
  const {chromium}=await import(pathToFileURL(library).href);browser=await chromium.launch({headless:true});
  context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(65000);page.on('pageerror',()=>failures.push(new Error("Browser application error.")));
  await page.route('**/*',async(route:any)=>{if(new URL(route.request().url()).origin!==origin){failures.push(new Error("Foreign browser request."));await route.abort();}else await route.continue();});
  await page.goto(origin);
  const button=(name:string)=>page.getByRole('button',{name,exact:true});
  const enabled=async(name:string)=>{await button(name).waitFor();await page.waitForFunction(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent===${JSON.stringify(name)}&&!button.disabled)`);};
  const selected=()=>button(`${input.databaseId} (${({postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',mongodb:'MongoDB',redis:'Redis'} as Record<string,string>)[input.engine]})`);
  const close=async()=>{await context?.close();await browser?.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));};
  return {
   async create(){
    await page.getByLabel('Database name').fill(input.databaseId);await page.getByLabel('Engine').selectOption(input.engine);
    await button('Prepare database').click();await enabled('Create database');await button('Create database').click();await enabled('Stop database');
    await selected().waitFor();if(!applyResponse||failures.length)throw new Error("Browser creation failed.");
    await page.goto('about:blank');return applyResponse;
   },
   async cycle(persistence:()=>Promise<void>){
    await page.goto(origin);await selected().click();await enabled('Start database');
    if(!await button('Stop database').isDisabled())throw new Error("Stopped control mismatch.");
    await button('Start database').click();await enabled('Stop database');if(!await button('Start database').isDisabled())throw new Error("Running control mismatch.");
    await button('Metrics').click();await page.getByText('CPU',{exact:true}).waitFor();await button('Logs').click();await page.getByLabel('Database logs').waitFor();
    await button('Reload databases').click();await enabled('Stop database');
    await page.reload();await selected().click();await enabled('Stop database');
    await button('Stop database').click();await enabled('Start database');await page.reload();await selected().click();await enabled('Start database');
    await button('Start database').click();await enabled('Stop database');await persistence();
    await page.goto('about:blank');
    const proof={sourceCommit,engine:input.engine,projectId:input.projectId,databaseId:input.databaseId,creation:'passed',selection:'passed',reload:'passed',telemetry:'passed',start:'passed',stop:'passed',persistence:'passed',browser:'chromium',context:'isolated',requests};
    if(failures.length||!validateBrowserProof(proof,sourceCommit))throw new Error("Incomplete browser acceptance.");return proof;
   },close
  };
 }catch(error){await context?.close();await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));throw error;}
}
