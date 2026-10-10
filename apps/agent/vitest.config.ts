import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { excludedPhysicalTestFiles } from "../../scripts/ci/test-scopes.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@deploylite/config": resolve(__dirname, "../../packages/config/src/index.ts"),
      "@deploylite/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@deploylite/domain": resolve(__dirname, "../../packages/domain/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...excludedPhysicalTestFiles("agent")]
  }
});
