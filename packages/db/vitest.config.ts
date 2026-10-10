import { configDefaults, defineConfig } from "vitest/config";
import { excludedPhysicalTestFiles } from "../../scripts/ci/test-scopes.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@deploylite/config": new URL("../config/src/index.ts", import.meta.url).pathname,
      "@deploylite/contracts": new URL("../contracts/src/index.ts", import.meta.url).pathname,
      "@deploylite/domain": new URL("../domain/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...excludedPhysicalTestFiles("db")]
  }
});
