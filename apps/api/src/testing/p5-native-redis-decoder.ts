/** Hosted-only restore; temporary socket server never opens a TCP port. */
import {spawn} from "node:child_process";
import {runPrivateRestoreFixture,type PrivateRestoreInput,type FixtureSpawn} from "./p5-native-private-restore-process.js";
export async function restoreNativeRedisFixture(input:PrivateRestoreInput,start:FixtureSpawn=spawn):Promise<void>{
 const script=`set -eu; dir=$(mktemp -d /tmp/p5-restore.XXXXXXXX); pid=""; cleanup(){ if test -n "$pid"; then kill "$pid" >/dev/null 2>&1 || true; wait "$pid" >/dev/null 2>&1 || true; fi; rm -rf -- "$dir"; }; trap cleanup EXIT; trap 'exit 143' TERM; tar -xf - -C "$dir"; printf 'port 0\\nunixsocket %s/socket\\nunixsocketperm 700\\ndir %s\\nappendonly yes\\nsave ""\\nrequirepass %s\\n' "$dir" "$dir" "$REDIS_PASSWORD" | redis-server - >/dev/null 2>&1 & pid=$!; export REDISCLI_AUTH="$REDIS_PASSWORD"; n=0; until redis-cli --no-auth-warning -s "$dir/socket" PING >/dev/null 2>&1; do n=$((n+1)); test "$n" -lt 50; sleep 0.1; done; original=$(redis-cli --no-auth-warning -h 127.0.0.1 --raw GET p5_probe); restored=$(redis-cli --no-auth-warning -s "$dir/socket" --raw GET p5_probe); test "$original" = "$restored"; test "$restored" = p5-persistent-value; cleanup; pid=""; trap - EXIT; printf 'p5-persistent-value\\n'`;
 await runPrivateRestoreFixture(input,script,start);
}
