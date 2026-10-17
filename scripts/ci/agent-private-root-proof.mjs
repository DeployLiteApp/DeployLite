import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function admit(env,event,head){
  assert.equal(env.GITHUB_ACTIONS,'true');
    assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
    assert.equal(env.RUNNER_OS,'Linux');
  assert.equal(env.GITHUB_REPOSITORY,'DeployLiteApp/DeployLite');
    assert.equal(event.repository.full_name,env.GITHUB_REPOSITORY);
  assert.equal(env.GITHUB_JOB,'compose-and-supply-chain');
    assert.match(env.GITHUB_RUN_ID,/^[1-9]\d*$/);
    assert.match(env.GITHUB_RUN_ATTEMPT,/^[1-9]\d*$/);
  assert.match(head,/^[a-f0-9]{40}$/);
    assert.equal(env.GITHUB_SHA,head);
    assert(!env.DOCKER_HOST&&!env.DOCKER_CONTEXT);
  assert(['push','pull_request'].includes(env.GITHUB_EVENT_NAME));
  if(env.GITHUB_EVENT_NAME==='pull_request')assert.equal(event.pull_request.head.repo.full_name,env.GITHUB_REPOSITORY);
}
export function checkComposition({dockerfile,compose,workflow}){
  for(const [target,tag] of [['runtime','api'],['agent','agent'],['migration','migration']])assert(new RegExp(`docker build --target ${target}[^\\n]*--tag deploylite-${tag}:ci`).test(workflow));
  assert(dockerfile.includes('USER 10001\n')&&dockerfile.includes('addgroup deploylite-agent docker'));
  const agent=compose.match(/^  agent:\n([\s\S]*?)(?=^  web:)/m)?.[1];
    assert(agent?.includes('source: agent-backups')&&agent.includes('target: /var/lib/deploylite-agent/backups'));
  assert.equal((compose.match(/source: agent-backups/g)||[]).length,1);
    assert(!agent.includes('nocopy: true'));
  for(const name of ['agent.sbom.json','agent.trivy.json'])assert.equal(workflow.split(name).length-1,2);
  assert(workflow.includes('node scripts/ci/agent-private-root-proof.mjs')&&workflow.includes('steps.agent_image_trivy_scan.outcome'));
}
/** A generated name is not ownership: guard every volume effect with actual daemon readback. */
export function useOwnedVolume(volume,name,token,operation){
  assert.equal(volume.Name,name);
  assert.equal(volume.Labels?.['deploylite.agent-root'],token);
  return operation(volume);
}
export function assertCapabilities(actual,setup){
  const values=actual??[];
  assert(Array.isArray(values));
  const normalized=values.map(value=>{assert.equal(typeof value,'string');return value.replace(/^CAP_/,'');});
  assert.deepEqual(normalized.sort(),setup?['CHOWN','DAC_OVERRIDE','FOWNER']:[]);
}
async function main(){
  const env=process.env,report={schema:'deploylite.agent-private-root/v1',status:'failed',cases:[],cleanup:{complete:false}};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const execute=(argv,until)=>{const remaining=until-Date.now();
    assert(remaining>0,'probe deadline');
    return spawnSync(argv[0],argv.slice(1),{encoding:'utf8',timeout:Math.min(20000,remaining),maxBuffer:1048576});};
  const head=execute(['git','rev-parse','HEAD'],Date.now()+5000);
    assert.equal(head.status,0);
  admit(env,JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')),head.stdout.trim());
  checkComposition({dockerfile:readFileSync('apps/api/Dockerfile','utf8'),compose:readFileSync('infra/vps/compose.yml','utf8'),workflow:readFileSync('.github/workflows/baseline.yml','utf8')});
  const deadline=Date.now()+120000,token=`agent-root-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${randomUUID()}`;
  const label=`deploylite.agent-root=${token}`,containers=[],volumes=[],root='/var/lib/deploylite-agent/backups';
  report.ownership={token,labelKey:'deploylite.agent-root',deadlineMs:120000,cleanupDeadlineMs:30000};
  report.context={repository:env.GITHUB_REPOSITORY,head:head.stdout.trim(),run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,job:env.GITHUB_JOB};
  report.sources=Object.fromEntries([...new Set([...JSON.parse(readFileSync('scripts/ci/p2-acceptance-cases.json')).sourceFiles,'pnpm-lock.yaml'])].map(path=>[path,hash(readFileSync(path))]));
  const command=(args,until=deadline)=>{const result=execute(['docker','--host','unix:///var/run/docker.sock',...args],until);
    assert.equal(result.status,0,`${args[0]}: ${result.stderr}`);
    return result.stdout.trim();};
  const inspect=(kind,id,until=deadline)=>JSON.parse(command([kind,'inspect',id],until))[0];
  const volume=()=>{const name=`${token}-${volumes.length}`;volumes.push(name);command(['volume','create','--label',label,name]);
    return useOwnedVolume(inspect('volume',name),name,token,()=>name);};
  const account=`const fs=await import('node:fs');console.log(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),groups:process.getgroups(),passwd:fs.readFileSync('/etc/passwd','utf8').split('\\n').filter(Boolean).map(x=>x.split(':')).map(x=>({name:x[0],uid:Number(x[2]),gid:Number(x[3])})),docker:fs.readFileSync('/etc/group','utf8').split('\\n').find(x=>x.startsWith('docker:'))}));`;
  const script=(image,source,{mount,user,setup=false,target=root}={})=>{
    const name=`${token}-container-${containers.length}`;containers.push(name);
    const args=['create','--name',name,'--label',label,'--network','none','--read-only','--cpus','0.5','--memory','256m','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges'];
    if(setup)args.push('--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER');
    if(user)args.push('--user',user);
    if(mount)args.push('--mount',`type=volume,source=${mount},target=${target}`);
    args.push('--entrypoint','node',image,'--input-type=module','-e',source);
    let volumeOwnership;
    const id=mount?useOwnedVolume(inspect('volume',mount),mount,token,volume=>{
      volumeOwnership={name:volume.Name,labels:volume.Labels};return command(args);
    }):command(args);
    const info=inspect('container',id);
    assert.equal(info.Config.Labels['deploylite.agent-root'],token);
    assert.equal(info.Image,image);
    assert.equal(info.Mounts.length,mount?1:0);
    if(mount)assert(info.Mounts.some(x=>x.Type==='volume'&&x.Name===mount&&x.Destination===target&&x.RW));
    assert.deepEqual(info.HostConfig.CapDrop,['ALL']);
    assertCapabilities(info.HostConfig.CapAdd,setup);
    assert.equal(info.HostConfig.Memory,268435456);
    assert.equal(info.HostConfig.NanoCpus,500000000);
    assert.equal(info.HostConfig.PidsLimit,64);
    assert(info.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(info.HostConfig.NetworkMode,'none');
    assert.equal(info.HostConfig.Privileged,false);
    assert.equal(info.HostConfig.ReadonlyRootfs,true);
    assert(!info.HostConfig.Binds?.length&&!Object.keys(info.HostConfig.PortBindings||{}).length);
    const output=command(['start','--attach',id]);
    assert.equal(inspect('container',id).State.ExitCode,0);
    return {id,name,image:info.Image,labels:info.Config.Labels,volumeOwnership,setup,user:info.Config.User,mounts:info.Mounts.map(x=>({type:x.Type,name:x.Name,target:x.Destination,writable:x.RW})),isolation:{network:info.HostConfig.NetworkMode,privileged:info.HostConfig.Privileged,readOnly:info.HostConfig.ReadonlyRootfs,capAdd:info.HostConfig.CapAdd,capDrop:info.HostConfig.CapDrop,memory:info.HostConfig.Memory,nanoCpus:info.HostConfig.NanoCpus,pids:info.HostConfig.PidsLimit},observation:JSON.parse(output)};
  };
  const validator=`const {validatePrivateArchiveRuntimeRoots}=await import('./dist/infrastructure/docker/private-archive-runtime-root.js');`;
  const filesystem=`const fs=await import('node:fs/promises'),crypto=await import('node:crypto');
    const root=${JSON.stringify(root)};`;
  try{
    const images=Object.fromEntries(['api','agent','migration'].map(name=>[name,inspect('image',`deploylite-${name}:ci`)]));
    for(const [name,image] of Object.entries(images)){assert.match(image.Id,/^sha256:[a-f0-9]{64}$/);
    assert.equal(image.Config.Labels['deploylite.ci.head'],report.context.head);
    assert.equal(image.Config.Labels['deploylite.ci.target'],name==='api'?'runtime':name);}
    assert.deepEqual(images.api.Config.Cmd,['node','dist/index.js']);
    assert.deepEqual(images.agent.Config.Cmd,['node','dist/index.js']);
    assert.deepEqual(images.migration.Config.Entrypoint,['node','scripts/migrate.mjs']);
    assert.equal(images.agent.Config.User,'10001');
    const accounts=Object.fromEntries(Object.entries(images).map(([name,image])=>[name,script(image.Id,account)]));
    const agent=accounts.agent.observation;
    assert.equal(agent.uid,10001);
    assert.equal(agent.gid,10001);
    assert.equal(agent.passwd.filter(x=>x.uid===10001).length,1);
    assert.equal(agent.passwd.find(x=>x.uid===10001).name,'deploylite-agent');
    const docker=agent.docker.split(':');
    assert(docker[3].split(',').includes('deploylite-agent')&&agent.groups.includes(Number(docker[2])));
    for(const name of ['api','migration'])assert(accounts[name].observation.uid!==0&&accounts[name].observation.uid!==agent.uid);
    report.images=Object.fromEntries(Object.entries(images).map(([name,image])=>[name,{id:image.Id,target:image.Config.Labels['deploylite.ci.target'],head:image.Config.Labels['deploylite.ci.head'],config:{user:image.Config.User,cmd:image.Config.Cmd,entrypoint:image.Config.Entrypoint},account:accounts[name]}]));
    const owned=volume(),sentinel='bounded-private-agent-proof';
    const observation=`const info=await fs.stat(root);
    const bytes=await fs.readFile(root+'/original.bin');console.log(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),owner:info.uid,group:info.gid,mode:info.mode&4095,dev:info.dev,ino:info.ino,names:await fs.readdir(root),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));`;
    const first=script(images.agent.Id,filesystem+validator+`await validatePrivateArchiveRuntimeRoots(new Map([['proof',root]]));await fs.writeFile(root+'/original.bin',${JSON.stringify(sentinel)},{flag:'wx',mode:384});`+observation,{mount:owned});
    assert.equal(first.observation.uid,10001);
    assert.deepEqual(first.observation.names,['original.bin']);
    assert.equal(first.observation.owner,10001);
    assert.equal(first.observation.group,10001);
    assert.equal(first.observation.mode,448);
    assert.equal(first.observation.sha256,hash(sentinel));
    command(['rm',first.id]);
    const second=script(images.agent.Id,filesystem+validator+`await validatePrivateArchiveRuntimeRoots(new Map([['proof',root]]));`+observation,{mount:owned});
    assert.notEqual(first.id,second.id);
    assert.deepEqual(second.observation,first.observation);
    report.cases.push({name:'mounted-root-recreation',volume:owned,target:root,first,second});
    const denied=script(images.agent.Id,filesystem+`const attempts={readdir:()=>fs.readdir(root),create:()=>fs.writeFile(root+'/new.bin','no',{flag:'wx'}),read:()=>fs.readFile(root+'/original.bin'),write:()=>fs.open(root+'/original.bin','r+'),unlink:()=>fs.unlink(root+'/original.bin'),rename:()=>fs.rename(root+'/original.bin',root+'/renamed.bin')};
    const results=[];for(const [name,work]of Object.entries(attempts)){try{await work();results.push({name,code:'UNEXPECTED_SUCCESS'});}catch(error){results.push({name,code:error.code});}}console.log(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),results}));`,{mount:owned,user:'10002:10002'});
    assert.equal(denied.observation.uid,10002);
    assert.equal(denied.observation.results.length,6);for(const value of denied.observation.results)assert(['EACCES','EPERM'].includes(value.code));
    const unchanged=script(images.agent.Id,filesystem+observation,{mount:owned});
    assert.deepEqual(unchanged.observation,first.observation);
    report.cases.push({name:'second-uid-denials',denied,unchanged});
    for(const [name,setup,path]of [
      ['root-owner',`await fs.chown(root,0,0);`,root],['foreign-owner',`await fs.chown(root,10002,10002);`,root],
      ['public-root',`await fs.chmod(root,511);`,root],['public-parent',`await fs.chmod('/var/lib/deploylite-agent',511);`,root],
      ['symlink',`await fs.symlink('/tmp',root+'/child');`,root+'/child'],['outside','', '/tmp']
    ]){
      const bad=volume(),target=name==='public-parent'?'/var/lib/deploylite-agent':root;
    const preparation=script(images.agent.Id,filesystem+`await fs.writeFile(root+'/.fixture','owned fixture',{flag:'wx',mode:384});
      const marker=await fs.readFile(root+'/.fixture');
      if(marker.toString()!=='owned fixture')throw new Error('Fixture marker readback failed.');
      ${setup}
      const fixture=await fs.lstat(${JSON.stringify(path)}),parent=await fs.lstat('/var/lib/deploylite-agent');console.log(JSON.stringify({prepared:true,marker:{bytes:marker.length,sha256:crypto.createHash('sha256').update(marker).digest('hex')},uid:fixture.uid,gid:fixture.gid,mode:fixture.mode&4095,symlink:fixture.isSymbolicLink(),parentMode:parent.mode&4095}));`,{mount:bad,user:'0:0',setup:true,target});
      assert.deepEqual(preparation.observation.marker,{bytes:13,sha256:hash('owned fixture')});
      const refusal=script(images.agent.Id,filesystem+validator+`let error;try{await validatePrivateArchiveRuntimeRoots(new Map([['bad',${JSON.stringify(path)}]]));}catch(value){error=value.message;}console.log(JSON.stringify({error}));`,{mount:bad,target});
      assert.equal(preparation.observation.prepared,true);
      if(name==='root-owner')assert.equal(preparation.observation.uid,0);
    if(name==='foreign-owner')assert.equal(preparation.observation.uid,10002);
      if(name==='public-root')assert.equal(preparation.observation.mode,511);
    if(name==='public-parent')assert.equal(preparation.observation.parentMode,511);
    if(name==='symlink')assert.equal(preparation.observation.symlink,true);
      assert.equal(refusal.observation.error,'Private archive root is unavailable.');
    report.cases.push({name,volume:bad,preparation,refusal});
    }
    report.status='passed';
  }catch(error){report.error={name:error.name,message:error.message};throw error;}
  finally{
    const until=Date.now()+30000,cleanupErrors=[],readbacks=[];
    for(const [kind,ids]of [['container',containers],['volume',volumes]])for(const id of ids){
      try{const present=execute(['docker','--host','unix:///var/run/docker.sock',kind,'inspect',id],until);
    if(present.status===0){const value=JSON.parse(present.stdout)[0];
    assert.equal((kind==='container'?value.Config.Labels:value.Labels)['deploylite.agent-root'],token);
    if(kind==='volume')useOwnedVolume(value,id,token,()=>command([kind,'rm',id],until));
    else command([kind,'rm','--force',id],until);}else assert.match(present.stderr,/No such (object|container|volume)/i);
        const absent=execute(['docker','--host','unix:///var/run/docker.sock',kind,'inspect',id],until);
    assert.equal(absent.status,1);
    assert.match(absent.stderr,/No such (object|container|volume)/i);readbacks.push({kind,id,absenceExit:absent.status,absenceMessage:absent.stderr.trim()});
      }catch(error){cleanupErrors.push({kind,id,error:error.message});}
    }
    report.cleanup={complete:cleanupErrors.length===0,containers,volumes,readbacks,errors:cleanupErrors};
    if(cleanupErrors.length)report.status='failed';
    mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/agent-private-root.json',JSON.stringify(report,null,2)+'\n');
    assert.equal(cleanupErrors.length,0,'owned cleanup failed');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
