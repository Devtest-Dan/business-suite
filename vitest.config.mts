import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // Next resolves this marker package itself; under Vitest it is a no-op.
      "server-only": fileURLToPath(new URL("./tests/unit/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globalSetup: ["tests/unit/global-setup.ts"],
    setupFiles: ["tests/unit/setup-env.ts"],
    // The tests share one database: run the files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    // Database setup in beforeAll/beforeEach can be slow on a loaded machine; give it the same room.
    hookTimeout: 30_000,
  },
});
