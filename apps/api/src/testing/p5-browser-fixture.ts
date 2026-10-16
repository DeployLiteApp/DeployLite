/** Hosted acceptance only: isolated Chromium and same-source React; no module-load services. */
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import type {FastifyInstance} from "fastify";
import {browserFixtureRequestFailure,type BrowserFixtureRequestStage,browserDeletionRecoveryFailure,validateBrowserProof,validateDeletionBrowserProof,validateBackupBrowserProof} from "./p5-browser-proof.js";
const root=resolve(import.meta.dirname,"../../../..");
/** Compile the actual application stylesheet with its existing production plugin. */
export async function buildDatabaseBrowserStyles(){
 const webRequire=createRequire(resolve(root,"apps/web/package.json")),postcss=webRequire("postcss"),tailwind=webRequire("@tailwindcss/postcss");
 const from=resolve(root,"apps/web/src/app/globals.css");
 return (await postcss([tailwind({base:resolve(root,"apps/web")})]).process(await readFile(from,"utf8"),{from})).css;
}
/** Browser library types are isolated CI tooling, not a production dependency. */
export async function openDatabaseBrowser(input:{sourceCommit:string;projectId:string;databaseId:string;engine:string;actorId:string;cookie:string;app():FastifyInstance}) {
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(input.actorId))throw new Error("Current fixture actor required.");
 if(process.platform!=="linux"||process.env.GITHUB_ACTIONS!=="true"||process.env.RUNNER_ENVIRONMENT!=="github-hosted"
  ||process.env.GITHUB_JOB!=="p5-native-operator-acceptance"||process.env.DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT!=="P5_OPERATOR_CI_APPROVED")throw new Error("Hosted browser admission required.");
 const sourceCommit=input.sourceCommit;
 if(!/^[a-f0-9]{40}$/.test(sourceCommit)||sourceCommit!==process.env.DEPLOYLITE_P5_EXPECTED_SHA
  ||execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()!==sourceCommit
  ||execFileSync("git",["diff","--name-only",sourceCommit,"--","apps/web","packages/contracts"],{cwd:root,encoding:"utf8"}).trim())throw new Error("Browser must exercise exact bound current source.");
 const library=process.env.DEPLOYLITE_P5_BROWSER_LIBRARY;
 if(!library||library!==resolve(process.env.RUNNER_TEMP!,"deploylite-p5-browser-tooling/node_modules/playwright/index.mjs"))throw new Error("Scoped browser tooling required.");
 const require=createRequire(import.meta.url),viteRequire=createRequire(createRequire(require.resolve("vitest/package.json")).resolve("vite")),esbuild=viteRequire("esbuild");
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {ManagedDatabaseWorkbench} from './apps/web/src/components/managed-database-workbench';createRoot(document.getElementById('root')).render(React.createElement(ManagedDatabaseWorkbench,{projectId:${JSON.stringify(input.projectId)},apiBaseUrl:location.origin,actorId:${JSON.stringify(input.actorId)}}));`;
 const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",
  alias:{"@":resolve(root,"apps/web/src"),"@deploylite/contracts":resolve(root,"packages/contracts/src/index.ts")},nodePaths:[resolve(root,"apps/web/node_modules")],define:{"process.env.NODE_ENV":'"production"'}});
 const script=bundle.outputFiles[0].text,styles=await buildDatabaseBrowserStyles();
 type ApiResponse={statusCode:number;body:string;json():any};
 let requests=0,applyResponse:ApiResponse|undefined;
 let originalBackup:{response:ApiResponse;key:string;body:Record<string,unknown>}|undefined,backupLostReply=false,backupRequestStart=0;
 const getOriginalBackup=()=>originalBackup;
 const backupCalls:{key:string;commandId:string;archiveId:string;actorId:string;status:number}[]=[];
 let deletionPreparation:{response:typeof applyResponse;key:string}|undefined,deletionRequestStart=0;
 const deletionCalls:{key:string;confirmationId:string;status:number}[]=[];
 const failures:Error[]=[],requestFailures:string[]=[];
 // Only the explicit owner may suspend admission; all admitted bodies/injections must finish first.
 const admitted = new Set<Promise<void>>();
 let closed = false;
 let reopening: {ready: Promise<boolean>; release(ready: boolean): void} | undefined;
 async function admitRequest(): Promise<() => void> {
  if (closed) throw new Error("Owned browser API unavailable.");
  const transition = reopening;
  if (transition) {
   if (!await transition.ready) throw new Error("Owned browser API unavailable.");
   return admitRequest();
  }
  let finish!: () => void;
  const completion = new Promise<void>(done => { finish = done; });
  admitted.add(completion);
  return () => { admitted.delete(completion); finish(); };
 }
 const server=createServer(async(req,res)=>{
  let stage:BrowserFixtureRequestStage="routing";
  let releaseRequest: (() => void) | undefined;
  try{
   if(req.url==="/"&&req.method==="GET"){res.setHeader("Content-Type","text/html");res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');return;}
   if(req.url==="/fixture.css"&&req.method==="GET"){res.setHeader("Content-Type","text/css");res.end(styles);return;}
   if(req.url==="/fixture.js"&&req.method==="GET"){res.setHeader("Content-Type","application/javascript");res.end(script);return;}
   if(req.url==="/favicon.ico"){res.writeHead(204);res.end();return;}
   const prefix=`/api/v1/projects/${input.projectId}/databases`;
   if(!req.url?.startsWith(prefix)||!['GET','POST'].includes(req.method!))throw new Error("Unscoped browser API request.");
   stage="app";releaseRequest=await admitRequest();
   stage="body";let bytes="";for await(const chunk of req){bytes+=chunk;if(Buffer.byteLength(bytes)>131072)throw new Error("Bounded browser request required.");}
   if(++requests>1000)throw new Error("Bounded browser request count required.");
   const headers:{cookie:string;"idempotency-key"?:string;"x-deploylite-expected-actor-id"?:string}={cookie:input.cookie};
   if(typeof req.headers['idempotency-key']==='string')headers['idempotency-key']=req.headers['idempotency-key'];
   if(typeof req.headers['x-deploylite-expected-actor-id']==='string')headers['x-deploylite-expected-actor-id']=req.headers['x-deploylite-expected-actor-id'];
   stage="app";const currentApi=input.app();if(!currentApi)throw new Error("Owned browser API unavailable.");
   stage="inject";const response=await currentApi.inject({method:req.method as 'GET'|'POST',url:req.url,headers,...(bytes?{payload:JSON.parse(bytes)}:{})});
   stage="projection";if(req.url===prefix+`/${input.databaseId}/runtime/apply`&&response.statusCode===200)applyResponse=response;
   if(req.url===prefix+`/${input.databaseId}/runtime/delete/prepare`&&response.statusCode===200){
    if(!headers['idempotency-key'])throw new Error("Original deletion key required.");deletionPreparation={response,key:headers['idempotency-key']};
   }
   if(req.url===prefix+`/${input.databaseId}/runtime/delete/apply`)deletionCalls.push({key:headers['idempotency-key']!,confirmationId:JSON.parse(bytes).confirmationId,status:response.statusCode});
   if(req.url===prefix+`/${input.databaseId}/runtime/backup`&&response.statusCode===200){
    const data=response.json().data,key=headers['idempotency-key'],actor=headers['x-deploylite-expected-actor-id'];
    if(!key||actor!==input.actorId||data.command.idempotencyKey!==key)throw new Error("Original backup actor/key required.");
    originalBackup??={response,key,body:JSON.parse(bytes)};
    backupCalls.push({key,commandId:data.command.id,archiveId:data.receipt.archiveId,actorId:actor,status:response.statusCode});
    if(!backupLostReply){backupLostReply=true;res.writeHead(503,{"Content-Type":"application/json"});res.end('{"data":null,"error":{"code":"FIXTURE_LOST_REPLY"},"requestId":"fixture-lost-reply"}');return;}
   }
   stage="response";res.writeHead(response.statusCode,{"Content-Type":"application/json"});res.end(response.body);
  }catch(error){
   const code=error instanceof Error?Object.getOwnPropertyDescriptor(error,"code")?.value:undefined;
   requestFailures.push(browserFixtureRequestFailure({stage,aborted:req.aborted,code}));failures.push(new Error("Browser fixture request failed."));res.writeHead(500);res.end('{"error":"Fixture unavailable"}');}
  finally { releaseRequest?.(); }
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
  const close=async()=>{closed=true;reopening?.release(false);await context?.close();await browser?.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));};
  return {
   async reopenApplication<T>(reopen: () => Promise<T>): Promise<T> {
    if (closed || reopening) throw new Error("Owned browser application reopen unavailable.");
    let resume!: (ready: boolean) => void;
    const transition = {ready: new Promise<boolean>(done => { resume = done; }), release: (ready: boolean) => resume(ready)};
    reopening = transition;
    let ready = false;
    try {
     await Promise.all(admitted);
     const result = await reopen();
     if (closed || !input.app()) throw new Error("Owned browser API unavailable.");
     ready = true;
     return result;
    } finally {
     reopening = undefined;
     transition.release(ready);
    }
   },
   async create(){
    await page.getByLabel('Database name').fill(input.databaseId);await page.getByLabel('Engine').selectOption(input.engine);
    await button('Prepare database').click();await enabled('Create database');await button('Create database').click();await enabled('Stop database');
    await selected().waitFor();await button('Create backup').waitFor();if(!applyResponse||failures.length)throw new Error("Browser creation failed.");
    await page.goto('about:blank');return applyResponse;
   },
   async backup(){
    if(originalBackup||backupCalls.length)throw new Error("One original manual backup required.");
    backupRequestStart=requests;await page.goto(origin);await selected().click();await enabled('Create backup');
    if(backupCalls.length)throw new Error("No automatic backup allowed.");
    await button('Create backup').click();await enabled('Retry backup confirmation');
    if(!originalBackup||backupCalls.length!==1||!backupLostReply)throw new Error("Original successful backup reply must be lost.");
    await page.reload();await selected().click();await enabled('Retry backup confirmation');
    if(backupCalls.length!==1)throw new Error("Reload must not replay a backup.");
    await button('Retry backup confirmation').click();await page.getByText('Backup completed.',{exact:true}).waitFor();
    const captured=getOriginalBackup();if(!captured)throw new Error("Original manual backup response required.");
    const data=captured.response.json().data;await page.getByText(data.receipt.archiveId,{exact:true}).waitFor();
    const proof={sourceCommit,engine:input.engine,projectId:input.projectId,databaseId:input.databaseId,actorId:input.actorId,browser:'chromium',context:'isolated',requests:requests-backupRequestStart,
     commandId:data.command.id,originalCommandId:data.receipt.originalCommandId,archiveId:data.receipt.archiveId,idempotencyKey:captured.key,destinationId:data.receipt.destinationId,
     manual:'passed',originalSource:'passed',lostReply:'passed',reload:'passed',sameOriginalKey:'passed',inventory:'passed',calls:[...backupCalls]};
    if(failures.length||!validateBackupBrowserProof(proof,sourceCommit))throw new Error("Incomplete original backup browser proof.");
    await page.goto('about:blank');return {...captured,proof};
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
   },
   async prepareRemoval(){
    deletionRequestStart=requests;await page.goto(origin);await selected().click();await enabled('Delete database');await button('Delete database').click();
    await page.getByRole('dialog',{name:'Delete database'}).waitFor();await page.getByText('Persistent storage and credentials will be retained.',{exact:true}).waitFor();
    if(!deletionPreparation?.response||failures.length)throw new Error("Original browser preparation required.");return deletionPreparation;
   },
   async applyRemovalExpectUnknown(){
    await button('Confirm deletion').click();await enabled('Retry deletion confirmation');
    if(deletionCalls.length!==1||deletionCalls[0]!.status!==503||failures.length)throw new Error("One uncertain browser removal required.");
   },
   async recoverRemoval(retainedStorage:()=>Promise<void>){
    await button('Retry deletion confirmation').click();await page.getByText('No stored databases.',{exact:true}).waitFor();
    await page.reload();await page.getByText('No stored databases.',{exact:true}).waitFor();await retainedStorage();
    const original=deletionPreparation!.response!.json().data;
    const failure=browserDeletionRecoveryFailure({calls:deletionCalls,key:deletionPreparation!.key,confirmationId:original.confirmation.id,
     requestFailure:requestFailures[0],failures:failures.map(error=>error.message==="Foreign browser request."?"foreign":error.message==="Browser application error."?"application":"request")});
    if(failure)throw new Error("Original browser deletion recovery required ("+failure+").");
    const proof={sourceCommit,engine:input.engine,projectId:input.projectId,databaseId:input.databaseId,browser:'chromium',context:'isolated',preparation:'passed',confirmation:'passed',recovery:'passed',sameOriginalKey:'passed',inventory:'passed',reload:'passed',retainedStorage:'passed',requests:requests-deletionRequestStart};
    if(!validateDeletionBrowserProof(proof,sourceCommit))throw new Error("Complete destructive browser proof required.");await page.goto('about:blank');return proof;
   },close
  };
 }catch(error){await context?.close();await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));throw error;}
}
