import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@t-tax/core": resolve("packages/core/src/index.ts"),
      "@t-tax/db": resolve("packages/db/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    testTimeout: 30000
  }
})
