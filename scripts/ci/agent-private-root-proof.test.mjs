import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {admit,checkComposition,useOwnedVolume,assertCapabilities} from './agent-private-root-proof.mjs';
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
for(const phase of ['mount/setup','cleanup/removal'])test(`checks actual volume identity before ${phase} and preserves foreign objects`,()=>{
  const calls=[],name='owned-volume',token='owned-run';
  const effect=()=>{calls.push(phase);return 'owned-effect';};
  assert.equal(useOwnedVolume({Name:name,Labels:{'deploylite.agent-root':token}},name,token,effect),'owned-effect');
  assert.deepEqual(calls,[phase]);calls.length=0;
  for(const volume of [{Name:name,Labels:{'deploylite.agent-root':'foreign-run'}},{Name:'other-volume',Labels:{'deploylite.agent-root':token}},{Name:name,Labels:{}},{Name:name}]){
    assert.throws(()=>useOwnedVolume(volume,name,token,effect));assert.deepEqual(calls,[]);
  }
});
test('checks actual volume ownership before every mounted container creation, including root setup',()=>{
  const source=readFileSync('scripts/ci/agent-private-root-proof.mjs','utf8');
  assert.match(source,/mount\?useOwnedVolume\(inspect\('volume',mount\),mount,token,volume=>/);
});
test('uses the same actual volume ownership guard before finally removal',()=>{
  const source=readFileSync('scripts/ci/agent-private-root-proof.mjs','utf8');
  assert.match(source,/if\(kind==='volume'\)useOwnedVolume\(value,id,token,\(\)=>command\(\[kind,'rm',id\],until\)\)/);
});
test('reads a nonempty owned fixture marker before bad metadata and validation-container recreation',()=>{
  const source=readFileSync('scripts/ci/agent-private-root-proof.mjs','utf8');
  const write=source.indexOf("await fs.writeFile(root+'/.fixture'"),read=source.indexOf("await fs.readFile(root+'/.fixture'"),mutation=source.indexOf('${setup}',write);
  const readback=source.indexOf('assert.deepEqual(preparation.observation.marker',mutation),recreation=source.indexOf('const refusal=',mutation);
  assert(write>=0&&read>write&&mutation>read&&readback>mutation&&recreation>readback);
});
const runtimeFiles=['.node-version','package.json','pnpm-lock.yaml','apps/api/Dockerfile','apps/web/Dockerfile','scripts/runtime-contract.test.sh'];
function runtimeContract(dockerfile){
  const root=mkdtempSync(join(tmpdir(),'deploylite-runtime-contract-'));
  try{
    for(const path of runtimeFiles){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),readFileSync(path));}
    writeFileSync(join(root,'apps/api/Dockerfile'),dockerfile);
    assert.equal(spawnSync('git',['init','--quiet',root],{encoding:'utf8'}).status,0);
    return spawnSync('bash',['scripts/runtime-contract.test.sh'],{cwd:root,encoding:'utf8'});
  }finally{rmSync(root,{recursive:true,force:true});}
}
const runtimeChanges={valid:value=>value,legacyOwner:value=>value.replace('--chown=10001:10001 /agent','--chown=deploylite:deploylite /agent'),wrongSource:value=>value.replace('/agent /app','/prod /app'),wrongDestination:value=>value.replace('/agent /app','/agent /other'),rootAgent:value=>value.replace('USER 10001','USER 0'),legacyAgent:value=>value.replace('USER 10001','USER deploylite'),missingAgentCommand:value=>value.replace(/( AS agent[\s\S]*)CMD \["node", "dist\/index.js"\]/,'$1CMD ["node", "other.js"]'),missingDockerCLI:value=>value.replace('apk add --no-cache docker-cli','apk add --no-cache curl')};
for(const [name,change]of Object.entries(runtimeChanges))test(`runtime contract strictly scopes agent deployed copy and UID: ${name}`,()=>{
  const result=runtimeContract(change(sources().dockerfile));assert.equal(result.status,name==='valid'?0:1,result.stderr);
});
test('accepts only exact capability sets across Docker inspect prefix/order representations',()=>{
  for(const value of [['CAP_CHOWN','CAP_DAC_OVERRIDE','CAP_FOWNER'],['CHOWN','DAC_OVERRIDE','FOWNER'],['FOWNER','CAP_CHOWN','DAC_OVERRIDE']])assert.doesNotThrow(()=>assertCapabilities(value,true));
  for(const value of [[],null,undefined])assert.doesNotThrow(()=>assertCapabilities(value,false));
});
for(const [name,value]of Object.entries({missing:['CAP_CHOWN','CAP_FOWNER'],extra:['CAP_CHOWN','CAP_DAC_OVERRIDE','CAP_FOWNER','CAP_NET_ADMIN'],duplicate:['CHOWN','CHOWN','DAC_OVERRIDE','FOWNER'],aliasDuplicate:['CHOWN','CAP_CHOWN','DAC_OVERRIDE','FOWNER'],foreign:['CHOWN','DAC_OVERRIDE','NET_ADMIN'],malformed:['CAP_CAP_CHOWN','DAC_OVERRIDE','FOWNER'],lowercase:['chown','DAC_OVERRIDE','FOWNER'],padded:[' CHOWN','DAC_OVERRIDE','FOWNER'],nonString:[null,'DAC_OVERRIDE','FOWNER'],nonArray:'CHOWN',empty:[],absent:null}))test(`rejects invalid setup capability multiset: ${name}`,()=>assert.throws(()=>assertCapabilities(value,true)));
test('non-setup containers reject every added or malformed capability',()=>{
  for(const value of [['CAP_CHOWN'],['CHOWN'],false,0,''])assert.throws(()=>assertCapabilities(value,false));
});
test('binds exact capability validation before container start and preserves raw inspect evidence',()=>{
  const source=readFileSync('scripts/ci/agent-private-root-proof.mjs','utf8');
  const gate=source.indexOf('assertCapabilities(info.HostConfig.CapAdd,setup)');
  assert(gate>=0&&gate<source.indexOf("const output=command(['start','--attach',id])"));
  assert(source.includes('capAdd:info.HostConfig.CapAdd'));
});
