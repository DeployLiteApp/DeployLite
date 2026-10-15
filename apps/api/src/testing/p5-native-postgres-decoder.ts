/** Hosted-only stdin restore proof; no copied files or elevated container user. */
import {spawn,type ChildProcess,type SpawnOptions} from "node:child_process";
type FixtureSpawn=(file:string,argv:readonly string[],options:SpawnOptions)=>ChildProcess;
import {randomUUID} from "node:crypto";
export async function decodeNativePostgresFixture(input:Readonly<{containerId:string;uid:number;bytes:Buffer;signal:AbortSignal}>,start:FixtureSpawn=spawn):Promise<void>{
 if(!/^[a-f0-9]{64}$/.test(input.containerId)||!Number.isSafeInteger(input.uid)||input.uid<1||input.uid>4294967294||input.bytes.length<1||input.bytes.length>2097152||input.signal.aborted)throw new Error("Invalid private restore fixture scope.");
 if(start===spawn&&(process.platform!=="linux"||process.env.DEPLOYLITE_P5_OPERATOR_PHYSICAL!=="1"||process.env.DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT!=="P5_OPERATOR_CI_APPROVED"))throw new Error("Explicit hosted operator fixture required.");
 const database="p5_restore_"+randomUUID().replaceAll("-","");
 const script=`set -eu; export PGPASSWORD="$POSTGRES_PASSWORD"; db=${database}; createdb --host 127.0.0.1 --username "$POSTGRES_USER" --maintenance-db "$POSTGRES_DB" "$db"; cleanup(){ dropdb --host 127.0.0.1 --username "$POSTGRES_USER" --maintenance-db "$POSTGRES_DB" "$db"; }; trap cleanup EXIT; trap 'exit 143' TERM; gzip -cd | pg_restore --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$db" --no-owner --no-privileges --exit-on-error; original=$(psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT value FROM p5_probe ORDER BY value;"); restored=$(psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$db" --tuples-only --no-align --command "SELECT value FROM p5_probe ORDER BY value;"); test "$original" = "$restored"; test "$restored" = p5-persistent-value; cleanup; trap - EXIT; printf '%s\\n' "$restored"`;
 const argv=["exec","--interactive","--user",String(input.uid),input.containerId,"timeout","--signal=TERM","--kill-after=2s","12s","bash","-o","pipefail","-c",script];
 await new Promise<void>((resolve,reject)=>{
  const child=start("docker",argv,{shell:false,detached:true,stdio:["pipe","pipe","ignore"]});
  let output="",settled=false,inputComplete=false;
  let killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{if(!child.pid)return;const pid=child.pid;try{process.kill(-pid,"SIGTERM");}catch{return;}killTimer=setTimeout(()=>{try{process.kill(-pid,"SIGKILL");}catch{ /* owned CLI already exited */ }},2000);killTimer.unref();};
  const finish=(success:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);input.signal.removeEventListener("abort",abort);if(success)resolve();else{stop();reject(new Error("Private PostgreSQL restore fixture failed."));}};
  const abort=()=>finish(false),timer=setTimeout(abort,16000);
  input.signal.addEventListener("abort",abort,{once:true});
  child.on("error",abort);child.stdin?.on("error",abort);
  child.stdout?.on("data",(chunk:Buffer)=>{output+=chunk.toString("utf8");if(output.length>128)finish(false);});
  child.on("close",code=>{if(killTimer)clearTimeout(killTimer);finish(code===0&&inputComplete&&output.trim()==="p5-persistent-value");});
  if(input.signal.aborted){abort();return;}
  if(!child.stdin){abort();return;}
  child.stdin.end(input.bytes,()=>{inputComplete=true;});
 });
}
