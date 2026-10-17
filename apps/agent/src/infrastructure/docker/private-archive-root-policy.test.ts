import type {Stats} from "node:fs";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {composeBackupFilesystem} from "./docker-compose-volume-backup.js";
const io = vi.hoisted(() => ({infos: [] as unknown[], reads: 0, canonical: "/owned-archives", afterRealpath: undefined as (() => void) | undefined}));
vi.mock("node:fs/promises", async () => ({...await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
  lstat: vi.fn(async () => {const value = io.infos[Math.min(io.reads++, io.infos.length - 1)]; if (!value) throw new Error("missing private root"); return value;}),
  realpath: vi.fn(async () => {io.afterRealpath?.(); return io.canonical;}), mkdir: vi.fn(), chmod: vi.fn(), chown: vi.fn(), rm: vi.fn()}));
import {lstat, mkdir, chmod, chown, rm} from "node:fs/promises";
function info(patch: Partial<Stats> = {}) {return {uid: 1001, gid: 1001, dev: 1, ino: 2, mode: 0o40700,
  isDirectory: () => true, isSymbolicLink: () => false, ...patch} as Stats;}
beforeEach(() => {vi.clearAllMocks(); io.infos = [info()]; io.reads = 0; io.canonical = "/owned-archives"; io.afterRealpath = undefined; vi.spyOn(process as {geteuid: () => number}, "geteuid").mockReturnValue(1001);});
afterEach(() => {try {for (const repair of [mkdir, chmod, chown, rm]) expect(repair).not.toHaveBeenCalled();} finally {vi.restoreAllMocks();}});
for (const mode of [0o40700, 0o40500]) it(`accepts stable nonroot-owned private directory mode ${mode.toString(8)} without repair`, async () => {
  io.infos = [info({mode})]; const result = await composeBackupFilesystem.safeDirectory("/owned-archives", true);
  expect(result.path).toBe("/owned-archives"); expect(result.info).toMatchObject({uid: 1001, ino: 2, mode}); expect(lstat).toHaveBeenCalledTimes(2);
});
for (const uid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) it(`rejects unsupported effective identity ${String(uid)} before filesystem access`, async () => {
  vi.mocked(process.geteuid!).mockReturnValue(uid as number);
  await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"}); expect(lstat).not.toHaveBeenCalled();
});
it("rejects absent effective UID support before filesystem access", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "geteuid")!;
  try {Object.defineProperty(process, "geteuid", {...descriptor, value: undefined}); await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"}); expect(lstat).not.toHaveBeenCalled();}
  finally {Object.defineProperty(process, "geteuid", descriptor);}
});
for (const uid of [0, 1002, NaN, -1]) it(`rejects foreign or malformed directory owner ${String(uid)}`, async () => {
  io.infos = [info({uid})]; await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"});
});
for (const mode of [0o40777, 0o40710, 0o40701, 0o44700, 0o41700, 0o40600, 0o40000]) it(`rejects nonprivate, special or unsearchable directory mode ${mode.toString(8)}`, async () => {
  io.infos = [info({mode})]; await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"});
});
for (const patch of [{ino: 3}, {uid: 1002}, {mode: 0o40777}, {gid: 1002}, {dev: 2}]) it(`rejects awaited root replacement or metadata change ${JSON.stringify(patch)}`, async () => {
  io.infos = [info(), info(patch)]; await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"});
});
it("rejects effective UID changes across realpath await", async () => {
  io.afterRealpath = () => vi.mocked(process.geteuid!).mockReturnValue(1002);
  await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toMatchObject({code: "COMPOSE_BACKUP_UNSAFE_DESTINATION"});
});
it("rejects a symlink, non-directory, noncanonical target or relative destination", async () => {
  for (const patch of [{isSymbolicLink: () => true}, {isDirectory: () => false}]) {io.infos = [info(patch)]; await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toThrow();}
  io.infos = [info()]; io.canonical = "/foreign-root"; await expect(composeBackupFilesystem.safeDirectory("/owned-archives", true)).rejects.toThrow();
  await expect(composeBackupFilesystem.safeDirectory("relative-root", true)).rejects.toThrow();
});
it("preserves foreign/public source-directory semantics independently of destination policy", async () => {
  vi.mocked(process.geteuid!).mockReturnValue(0); io.infos = [info({uid: 2002, mode: 0o41777})];
  expect((await composeBackupFilesystem.safeDirectory("/owned-archives", false)).info.uid).toBe(2002); expect(lstat).toHaveBeenCalledTimes(1);
});
