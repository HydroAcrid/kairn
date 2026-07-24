import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    env: {
      KAIRN_CANDIDATE_MODE: "legacy"
    }
  }
});
