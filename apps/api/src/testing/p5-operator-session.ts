/** Hosted fixture utility only; excluded from production build, with no module-load effect. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { closeDbPool, createDbClient, createDbPool } from "@deploylite/db";
import { awaitAbortable } from "@deploylite/domain";
export type OperatorAdmission = Readonly<{
  nonce: string; databaseName: string; postgresContainerId: string; postgresPort: number;
  sourceHashes: Readonly<Record<string, string>>;
}>;
export type OperatorSessionPorts = Readonly<{
  admission(): Promise<OperatorAdmission>;
  migrations(): Promise<readonly Readonly<{ path: string; sql: string }>[]>;
  pool: typeof createDbPool;
}>;
const root = resolve(import.meta.dirname, "../../../..");
const runAdmissionCommand = promisify(execFile);
const defaults: OperatorSessionPorts = {
  admission: async () => {
    await runAdmissionCommand("python3", [resolve(root, "scripts/ci/p5-operator-admission.py"), "check"], { timeout: 20000, maxBuffer: 8192 });
    const path = resolve(globalThis.process.env.RUNNER_TEMP!, "deploylite-p5-operator-evidence/binding.json");
    const bytes = await readFile(path, "utf8");
    if (Buffer.byteLength(bytes) > 131072 || await readFile(path, "utf8") !== bytes) throw new Error("Changed private binding.");
    return JSON.parse(bytes) as OperatorAdmission;
  },
  migrations: async () => {
    const directory = resolve(root, "packages/db/migrations");
    return Promise.all((await readdir(directory)).filter(name => name.endsWith(".sql")).sort().map(async name => ({
      path: "packages/db/migrations/" + name, sql: await readFile(resolve(directory, name), "utf8")
    })));
  },
  pool: createDbPool
};
function validate(scope: OperatorAdmission, migrations: Awaited<ReturnType<OperatorSessionPorts["migrations"]>>) {
  if (!/^[a-f0-9]{24}$/.test(scope.nonce) || scope.databaseName !== "deploylite_p5_operator_" + scope.nonce
    || !/^[a-f0-9]{64}$/.test(scope.postgresContainerId) || !Number.isInteger(scope.postgresPort)
    || scope.postgresPort < 1024 || scope.postgresPort > 65535) throw new Error("Invalid operator admission.");
  const expected = Object.keys(scope.sourceHashes).filter(path => /^packages\/db\/migrations\/[A-Za-z0-9_-]+\.sql$/.test(path)).sort();
  if (!expected.length || JSON.stringify(migrations.map(value => value.path).sort()) !== JSON.stringify(expected)) throw new Error("Incomplete migration binding.");
  for (const migration of migrations) {
    if (createHash("sha256").update(migration.sql).digest("hex") !== scope.sourceHashes[migration.path]) throw new Error("Changed migration source.");
  }
}
/** Fixed loopback fixture identity only; no caller-supplied destination or destructive adoption. */
export async function openOperatorSession(ports: OperatorSessionPorts = defaults) {
  const signal = AbortSignal.timeout(60000), bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, signal);
  let stage = "admission", owned = false;
  let originalScope: OperatorAdmission | undefined, originalBinding: string | undefined;
  let maintenance: ReturnType<typeof createDbPool> | undefined, pool: ReturnType<typeof createDbPool> | undefined;
  const ends = new Map<ReturnType<typeof createDbPool>, Promise<void>[]>();
  const connect = (url: string) => {
    const value = ports.pool(url, { max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000, lock_timeout: 5000 });
    const sockets: Promise<void>[] = [];
    value.on("connect", client => { sockets.push(new Promise(resolve => { client.once("end", resolve); })); });
    ends.set(value, sockets); return value;
  };
  const close = async (value: ReturnType<typeof createDbPool> | undefined) => {
    if (!value) return;
    const closing = AbortSignal.timeout(15000);
    await awaitAbortable(() => closeDbPool(value), closing);
    await awaitAbortable(() => Promise.all(ends.get(value) ?? []), closing);
    ends.delete(value);
  };
  try {
    const scope = structuredClone(await bounded(() => ports.admission())), original = JSON.stringify(scope);
    originalScope = scope; originalBinding = original;
    stage = "migration-source";
    const migrations = structuredClone(await bounded(() => ports.migrations())); validate(scope, migrations);
    const base = "postgres://deploylite:deploylite-ci-only@127.0.0.1:" + scope.postgresPort;
    const reaffirm = async () => {
      if (JSON.stringify(await ports.admission()) !== original) throw new Error("Changed operator admission.");
    };
    maintenance = connect(base + "/postgres"); stage = "fresh-database";
    const exists = async () => Boolean((await maintenance!.query("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS exists", [scope.databaseName])).rows[0]?.exists);
    if (await bounded(exists)) throw new Error("Existing fixture database cannot be adopted.");
    await bounded(() => maintenance!.query('CREATE DATABASE "' + scope.databaseName + '"')); owned = true;
    pool = connect(base + "/" + scope.databaseName); stage = "migrate";
    for (const migration of migrations) await bounded(() => pool!.query(migration.sql));
    let closure: Promise<void> | undefined;
    return {
      databaseName: scope.databaseName,
      get pool() { return pool!; },
      get db() { return createDbClient(pool!); },
      async reopen() {
        if (closure) throw new Error("Operator session is closing.");
        await close(pool); pool = undefined; await reaffirm(); pool = connect(base + "/" + scope.databaseName);
      },
      close() {
        return closure ??= (async () => {
          try {
            await close(pool); pool = undefined; await reaffirm();
            await maintenance!.query('DROP DATABASE "' + scope.databaseName + '"'); owned = false;
            if (await exists()) throw new Error("Fixture database remains.");
          } finally {
            await close(pool); pool = undefined; await close(maintenance); maintenance = undefined;
          }
        })();
      }
    };
  } catch {
    let unresolved = false;
    try {
      await close(pool);
      if (owned) {
        if (!originalScope || JSON.stringify(await ports.admission()) !== originalBinding) unresolved = true;
        else await maintenance!.query('DROP DATABASE "' + originalScope.databaseName + '"');
      }
    } catch { unresolved = true; }
    try { await close(maintenance); } catch { unresolved = true; }
    throw new Error("Operator database fixture unavailable at " + stage + (unresolved ? "; cleanup unresolved." : "."));
  }
}
