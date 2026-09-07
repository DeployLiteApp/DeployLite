import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      "@deploylite/contracts": new URL("../contracts/src/index.ts", import.meta.url).pathname
    }
  }
});
