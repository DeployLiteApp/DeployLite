import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { renderDomainRouteDynamicConfig, type DomainRouteDynamicConfig } from "@deploylite/domain";

export type TraefikDomainRouteApplyInput = Readonly<{ route: unknown; receipt: unknown; agentId: string }>;
export type TraefikDomainRouteApplyResult = Readonly<{
  state: "created" | "updated" | "unchanged";
  fileName: string;
  contentDigest: string;
}>;

export class TraefikDomainRouteFileStoreError extends Error {
  constructor(readonly code: "directory-unavailable" | "path-invalid" | "write-failed") {
    super("The Traefik route file could not be applied safely.");
    this.name = "TraefikDomainRouteFileStoreError";
  }
}

const routeFileName = /^domain-route-[a-f0-9]{24}\.yml$/;
const maxConfigBytes = 16 * 1024;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class TraefikDomainRouteFileStore {
  constructor(private readonly directory: string) {}

  async apply(input: TraefikDomainRouteApplyInput): Promise<TraefikDomainRouteApplyResult> {
    const rendered: DomainRouteDynamicConfig = renderDomainRouteDynamicConfig(input);
    if (!isAbsolute(this.directory) || !routeFileName.test(rendered.fileName)
      || Buffer.byteLength(rendered.content, "utf8") === 0 || Buffer.byteLength(rendered.content, "utf8") > maxConfigBytes) {
      throw new TraefikDomainRouteFileStoreError("path-invalid");
    }
    const directory = resolve(this.directory);
    try {
      const directoryState = await lstat(directory);
      if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) throw new TraefikDomainRouteFileStoreError("directory-unavailable");
    } catch (error) {
      if (error instanceof TraefikDomainRouteFileStoreError) throw error;
      throw new TraefikDomainRouteFileStoreError("directory-unavailable");
    }

    const target = join(directory, rendered.fileName);
    let previous: Buffer | null = null;
    let state: TraefikDomainRouteApplyResult["state"] = "created";
    try {
      const targetState = await lstat(target);
      if (targetState.isSymbolicLink() || !targetState.isFile()) throw new TraefikDomainRouteFileStoreError("path-invalid");
      previous = await readFile(target);
      state = "updated";
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof TraefikDomainRouteFileStoreError) throw error;
        throw new TraefikDomainRouteFileStoreError("write-failed");
      }
    }

    const content = Buffer.from(rendered.content, "utf8");
    const contentDigest = createHash("sha256").update(content).digest("hex");
    if (previous?.equals(content)) {
      try { await syncDirectory(directory); } catch { throw new TraefikDomainRouteFileStoreError("write-failed"); }
      return { state: "unchanged", fileName: rendered.fileName, contentDigest };
    }

    const temporary = join(directory, `.domain-route-${randomBytes(16).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await syncDirectory(directory);
      return { state, fileName: rendered.fileName, contentDigest };
    } catch {
      try { await handle?.close(); } catch { /* keep the safe error below */ }
      try { await unlink(temporary); } catch { /* never scan or remove other files */ }
      throw new TraefikDomainRouteFileStoreError("write-failed");
    }
  }
}
