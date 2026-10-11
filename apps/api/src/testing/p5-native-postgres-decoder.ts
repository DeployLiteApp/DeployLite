/** Hosted-only stdin restore proof; no copied files or elevated container user. */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {runPrivateRestoreFixture,type PrivateRestoreInput,type FixtureSpawn} from "./p5-native-private-restore-process.js";
export async function decodeNativePostgresFixture(input:PrivateRestoreInput,start:FixtureSpawn=spawn):Promise<void>{
 const database="p5_restore_"+randomUUID().replaceAll("-","");
 const script=`set -eu; export PGPASSWORD="$POSTGRES_PASSWORD"; db=${database}; createdb --host 127.0.0.1 --username "$POSTGRES_USER" --maintenance-db "$POSTGRES_DB" "$db"; cleanup(){ dropdb --host 127.0.0.1 --username "$POSTGRES_USER" --maintenance-db "$POSTGRES_DB" "$db"; }; trap cleanup EXIT; trap 'exit 143' TERM; gzip -cd | pg_restore --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$db" --no-owner --no-privileges --exit-on-error; original=$(psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT value FROM p5_probe ORDER BY value;"); restored=$(psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$db" --tuples-only --no-align --command "SELECT value FROM p5_probe ORDER BY value;"); test "$original" = "$restored"; test "$restored" = p5-persistent-value; cleanup; trap - EXIT; printf '%s\\n' "$restored"`;
 await runPrivateRestoreFixture(input,script,start);
}
