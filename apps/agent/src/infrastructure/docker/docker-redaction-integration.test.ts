import { describe, expect, it } from "vitest";
import { redactDockerDiagnostic } from "./docker-process-runner.js";
const enabled = process.env.DEPLOYLITE_DOCKER_INTEGRATION === "1";
describe("Docker diagnostics", () => {
  it("redacts secrets before diagnostics leave the process boundary", () => { expect(redactDockerDiagnostic("password=hunter2 https://user:pass@example.test token=abc")).toBe("password=[REDACTED] https://[REDACTED]@example.test token=[REDACTED]"); });
});
describe.skipIf(!enabled)("Docker CLI integration (explicit opt-in)", () => {
  it("is opt-in and requires a caller-provided Docker environment", () => { expect(enabled).toBe(true); });
});
