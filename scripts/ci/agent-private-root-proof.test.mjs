import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {admit,checkComposition} from './agent-private-root-proof.mjs';
const head='a'.repeat(40),env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'DeployLiteApp/DeployLite',GITHUB_SHA:head,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'compose-and-supply-chain',GITHUB_EVENT_NAME:'pull_request'};
const event={repository:{full_name:env.GITHUB_REPOSITORY},pull_request:{head:{repo:{full_name:env.GITHUB_REPOSITORY}}}};
test('admits only the exact same-repository hosted packaging job and checkout',()=>assert.doesNotThrow(()=>admit(env,event,head)));
for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'self-hosted',RUNNER_OS:'Darwin',GITHUB_REPOSITORY:'other/repository',GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'',GITHUB_RUN_ATTEMPT:'0',GITHUB_JOB:'p5-native-database-acceptance',GITHUB_EVENT_NAME:'workflow_dispatch',DOCKER_HOST:'tcp://other',DOCKER_CONTEXT:'other'}))
  test(`rejects invalid packaging admission ${key}`,()=>assert.throws(()=>admit({...env,[key]:value},event,head)));
test('rejects foreign pull-request source',()=>assert.throws(()=>admit(env,{...event,pull_request:{head:{repo:{full_name:'foreign/repository'}}}},head)));
const sources=()=>({dockerfile:readFileSync('apps/api/Dockerfile','utf8'),compose:readFileSync('infra/vps/compose.yml','utf8'),workflow:readFileSync('.github/workflows/baseline.yml','utf8')});
test('pins explicit API and agent targets, agent-only mount and required agent scans/probe',()=>assert.doesNotThrow(()=>checkComposition(sources())));
for(const target of ['runtime','agent'])test(`rejects missing or swapped ${target} image target`,()=>{
  const value=sources();assert.throws(()=>checkComposition({...value,workflow:value.workflow.replace(`--target ${target}`,`--target ${target==='agent'?'runtime':'agent'}`)}));
  assert.throws(()=>checkComposition({...value,workflow:value.workflow.replace(`--target ${target} `,'')}));
});
for(const [name,change] of Object.entries({
  mount:value=>({...value,compose:value.compose.replace('source: agent-backups','source: postgres-data')}),
  uid:value=>({...value,dockerfile:value.dockerfile.replace('USER 10001','USER 0:0')}),
  scan:value=>({...value,workflow:value.workflow.replace('agent.trivy.json','missing.json')}),
  probe:value=>({...value,workflow:value.workflow.replace('node scripts/ci/agent-private-root-proof.mjs','echo disabled')})
}))test(`rejects missing ${name} packaging contract`,()=>assert.throws(()=>checkComposition(change(sources()))));
