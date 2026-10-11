/** Private in-container standalone lock lifetime. Never a stale-lock recovery API. */
/** mongosh parses sourceType=script before async rewriting; top-level await is invalid. */
export function asMongoCliScript(source:string):string{return "(async()=>{"+source+"\n})();";}
const connection=String.raw`const password=process.env.MONGO_INITDB_ROOT_PASSWORD,user=process.env.MONGO_INITDB_ROOT_USERNAME;
if(!/^[a-f0-9]{64}$/.test(password||"")||typeof user!=="string"||!user)throw new Error("Unavailable.");
const uri="mongodb://"+encodeURIComponent(user)+":"+encodeURIComponent(password)+"@127.0.0.1:27017/admin?authSource=admin&serverSelectionTimeoutMS=1000&connectTimeoutMS=1000&socketTimeoutMS=1000";
const admin=(await Mongo(uri)).getDB("admin");
const refuse=async(code)=>{const error=new Error("Unavailable.");error.identityCode=code;throw error;};
const identity=async()=>{let hello;try{hello=await admin.runCommand({hello:1});}catch{await refuse(32);}
if(hello.ok!==1)await refuse(33);if(hello.isWritablePrimary!==true)await refuse(34);if(hello.setName||hello.msg)await refuse(35);
let id;try{id=hello.topologyVersion?.processId?.toHexString();}catch{await refuse(36);}
if(!/^[a-f0-9]{24}$/.test(id||""))await refuse(36);return id;};`;
export const MONGO_BACKUP_LOCK_SCRIPT=asMongoCliScript(String.raw`let stage=21;try{${connection}
stage=22;const id=await identity();stage=23;const state=await admin.runCommand({currentOp:1});
if(state.ok!==1||(state.fsyncLock!==undefined&&state.fsyncLock!==false))throw new Error("Unavailable.");
let held=false,acknowledged=false;
try{stage=24;const locked=await admin.runCommand({fsync:1,lock:true,maxTimeMS:1000});
if(locked.ok!==1||!Number.isSafeInteger(Number(locked.lockCount))||Number(locked.lockCount)<1)throw new Error("Unavailable.");held=true;
stage=25;if(Number(locked.lockCount)!==1||await identity()!==id)throw new Error("Unavailable.");
await print(id);acknowledged=true;
}finally{if(held&&!acknowledged&&await identity()===id)await admin.runCommand({fsyncUnlock:1,maxTimeMS:1000});}
}catch(error){await quit(error.identityCode||stage);}void 0;`);
export const MONGO_BACKUP_UNLOCK_SCRIPT=asMongoCliScript(String.raw`try{${connection}
const id=process.env.DEPLOYLITE_MONGO_BACKUP_PROCESS_ID;
if(!/^[a-f0-9]{24}$/.test(id||"")||await identity()!==id)throw new Error("Unavailable.");
const unlocked=await admin.runCommand({fsyncUnlock:1,maxTimeMS:1000});
if(unlocked.ok!==1||Number(unlocked.lockCount)!==0)throw new Error("Unavailable.");
}catch(error){await quit(error.identityCode||27);}void 0;`);
function quote(value:string){return "'"+value.replaceAll("'",`'"'"'`)+"'";}
export function buildMongoNativeDumpArgv(containerId:string,deadline:number):readonly string[]{
 if(!/^[a-f0-9]{64}$/.test(containerId)||!Number.isSafeInteger(deadline)||deadline<1)throw new Error("Backup source is unavailable.");
 const dump=String.raw`[[ "$MONGO_INITDB_ROOT_PASSWORD" =~ ^[a-f0-9]{64}$ ]] && printf 'password: "%s"\n' "$MONGO_INITDB_ROOT_PASSWORD" | mongodump --quiet --config=/dev/stdin --host=127.0.0.1 --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin --db="$MONGO_INITDB_DATABASE" --archive --gzip`;
 const script=`set -eu; stamp=$(date +%s%3N) || exit 29; [[ "$stamp" =~ ^[0-9]+$ ]] || exit 29; test "$stamp" -lt ${deadline} || exit 29; test "$((${deadline}-stamp-2500))" -gt 0 || exit 29; token=""; cleanup(){ if test -n "$token"; then ownedToken="$token"; token=""; DEPLOYLITE_MONGO_BACKUP_PROCESS_ID="$ownedToken" mongosh --nodb --quiet --eval ${quote(MONGO_BACKUP_UNLOCK_SCRIPT)}; fi; }; trap cleanup EXIT; token=$(mongosh --nodb --quiet --eval ${quote(MONGO_BACKUP_LOCK_SCRIPT)}) || { code=$?; token=""; case "$code" in 21|22|23|24|25|32|33|34|35|36) exit "$code";; *) exit 31;; esac; }; [[ "$token" =~ ^[a-f0-9]{24}$ ]] || { token=""; exit 28; }; stamp=$(date +%s%3N) || exit 29; [[ "$stamp" =~ ^[0-9]+$ ]] || exit 29; remaining=$((${deadline}-stamp-2500)); test "$remaining" -gt 0 || exit 29; test "$remaining" -le 60000 || exit 29; seconds=$(printf '%d.%03d' "$((remaining/1000))" "$((remaining%1000))"); timeout --signal=TERM --kill-after=1s "$seconds" bash -o pipefail -c ${quote(dump)} || exit 26; cleanup; token=""; trap - EXIT`;
 return Object.freeze(["docker","exec",containerId,"bash","-o","pipefail","-c",script]);
}
