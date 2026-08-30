import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type DockerProcessExit = Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
export class DockerProcessError extends Error { constructor(readonly kind: "failed" | "timeout" | "canceled" | "output-limit", readonly result?: DockerProcessExit) { super(`docker process ${kind}`); this.name = "DockerProcessError"; } }
export type SpawnedProcess = Pick<ChildProcess, "stdout" | "stderr" | "once" | "kill"> & { pid?: number };
export type SpawnProcess = (file: string, args: readonly string[], options: { shell: false; detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => SpawnedProcess;
const defaultSpawn: SpawnProcess = (file, args, options) => nodeSpawn(file, args, options);

export type DockerProcessRunnerOptions = Readonly<{ spawn?: SpawnProcess; timeoutMs?: number; maxOutputBytes?: number }>;
export class DockerProcessRunner {
  readonly #spawn: SpawnProcess; readonly #timeoutMs: number; readonly #maxOutputBytes: number;
  constructor(options: DockerProcessRunnerOptions = {}) { this.#spawn = options.spawn ?? defaultSpawn; this.#timeoutMs = options.timeoutMs ?? 30_000; this.#maxOutputBytes = options.maxOutputBytes ?? 64 * 1024; }
  run(argv: readonly string[], signal: AbortSignal): Promise<DockerProcessExit> {
    if (argv.length === 0 || argv.some((part) => typeof part !== "string")) return Promise.reject(new DockerProcessError("failed"));
    return new Promise((resolve, reject) => {
      let child: SpawnedProcess; try { child = this.#spawn(argv[0]!, argv.slice(1), { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { reject(error); return; }
      let stdout = ""; let stderr = ""; let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: DockerProcessError) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); if (error) reject(error); };
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* process may already be gone */ } if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group may already be gone */ } } };
      const onAbort = () => { kill(); finish(new DockerProcessError("canceled")); };
      const append = (chunk: Buffer | string, target: "stdout" | "stderr") => { const value = chunk.toString(); if (stdout.length + stderr.length + value.length > this.#maxOutputBytes) { kill(); finish(new DockerProcessError("output-limit", { exitCode: null, signal: null, stdout, stderr })); return; } if (target === "stdout") stdout += value; else stderr += value; };
      child.stdout?.on("data", (chunk) => append(chunk, "stdout")); child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
      const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => { const result = { exitCode, signal: exitSignal, stdout, stderr }; if (settled) return; if (exitCode === 0) { settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(result); } else finish(new DockerProcessError("failed", result)); };
      child.once("close", onExit); signal.addEventListener("abort", onAbort, { once: true }); timer = setTimeout(() => { kill(); finish(new DockerProcessError("timeout", { exitCode: null, signal: "SIGKILL", stdout, stderr })); }, this.#timeoutMs);
      if (signal.aborted) onAbort();
    });
  }
}
