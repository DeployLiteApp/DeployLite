import {managedDatabaseHealthPreparationSchema,type ImageReferencePolicyV1} from "@deploylite/contracts";
import {planManagedDatabaseProfile,managedDatabaseRuntimeExecutionDigest} from "@deploylite/domain";
const commands={
 postgres:'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-acl --no-owner --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password | gzip',
 mysql:'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --default-character-set=utf8mb4 --host=127.0.0.1 --user=root --lock-all-tables --no-tablespaces --quick "$MYSQL_DATABASE" | gzip',
 mariadb:'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump --host=127.0.0.1 --user=root --lock-all-tables --quick --databases "$MARIADB_DATABASE" | gzip',
 mongodb:`[[ "$MONGO_INITDB_ROOT_PASSWORD" =~ ^[a-f0-9]{64}$ ]] && printf 'password: "%s"\\n' "$MONGO_INITDB_ROOT_PASSWORD" | mongodump --config=/dev/stdin --host=127.0.0.1 --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin --db="$MONGO_INITDB_DATABASE" --archive --gzip`
} as const;
const formats={postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"} as const;
const consistency={postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"} as const;
function fail():never {throw new Error("Backup source is unavailable.");}
/** Pure preparation only. Original signed cache, current ownership/authority and consistency must be proved before execution. */
export function buildManagedDatabaseBackupSource(raw:unknown,options:{agentId:string;profile:unknown;imagePolicy:ImageReferencePolicyV1}) {
 try {
  const source=managedDatabaseHealthPreparationSchema.parse(structuredClone(raw)),original=source.originalReceipt;
  const request={schemaVersion:1 as const,projectId:source.projectId,databaseId:source.databaseId,engine:source.engine};
  const plan=planManagedDatabaseProfile(request,options.profile,options.imagePolicy);
  if(original.agentId!==options.agentId||plan.profileId!==source.profileId||plan.planDigest!==source.planDigest
   ||original.inputDigest!==managedDatabaseRuntimeExecutionDigest({...request,profileId:source.profileId,planDigest:source.planDigest,environmentFingerprint:source.environmentFingerprint})
   ||original.volumeName!==plan.volume.runtimeName||original.networkName!==plan.network.runtimeName)fail();
  const argv=source.engine==="redis"?null:Object.freeze(["docker","exec",original.containerId!,"bash","-o","pipefail","-c","set -eu; "+commands[source.engine]]);
  return Object.freeze({...request,profileId:plan.profileId,planDigest:plan.planDigest,environmentFingerprint:source.environmentFingerprint,
   agentId:original.agentId,originalCommandId:original.commandId,containerId:original.containerId!,imageId:original.imageId!,image:plan.image,
   volumeName:original.volumeName,volumeCreatedAt:original.volumeCreatedAt!,networkName:original.networkName,networkId:original.networkId!,
   strategy:plan.backupStrategy,format:formats[source.engine],consistencyRequirement:consistency[source.engine],executionAllowed:false as const,argv});
 }catch{return fail();}
}

/** SQL read locks live inside the daemon; killing only its host Docker client cannot bound them. */
export function buildConsistentManagedDatabaseBackupArgv(source:ReturnType<typeof buildManagedDatabaseBackupSource>,deadline:number):readonly string[] {
 if(!Number.isSafeInteger(deadline)||deadline<1||!source.argv)fail();
 if(source.engine!=="mysql"&&source.engine!=="mariadb")return source.argv;
 const command=source.argv.at(-1)!;
 if(source.consistencyRequirement!=="global-read-lock"||!command.includes("--lock-all-tables")||command.includes("'"))fail();
 // Refuse missing clock/timeout tools. Reserve one second for the daemon-local forced termination.
 const script=[
  "set -eu",
  "stamp=$(date +%s%3N)",
  '[[ "$stamp" =~ ^[1-9][0-9]{0,15}$ ]] || exit 1',
  `remaining=$((${deadline} - stamp - 1000))`,
  'test "$remaining" -gt 0',
  `seconds=$(printf '%d.%03d' "$((remaining / 1000))" "$((remaining % 1000))")`,
  `exec timeout --signal=TERM --kill-after=1s "\${seconds}s" bash -o pipefail -c '${command}'`
 ].join("; ");
 return Object.freeze([...source.argv.slice(0,-1),script]);
}
