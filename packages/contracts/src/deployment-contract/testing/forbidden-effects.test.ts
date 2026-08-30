import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { assertNoDeploymentEffects } from "./forbidden-effects.js";
describe("deployment contract forbidden-effect probe", () => {
  it("keeps source intent, snapshot, and protocol pure", async () => {
    for (const file of ["source-intent.ts", "snapshot-plan.ts", "protocol.ts"]) {
      assertNoDeploymentEffects(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    }
  });
  it("detects process, filesystem, network, VPS, Docker, and secret access", () => {
    for (const source of ["docker build", "registry.pull()", "ssh vps", "spawn()", "exec()", "from \"node:fs\"", "fetch()", "https://x", "getSecret()"])
      expect(() => assertNoDeploymentEffects(source)).toThrow("forbidden effect");
  });
});
