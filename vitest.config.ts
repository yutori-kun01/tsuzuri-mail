import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite（WASM の PostgreSQL）の起動に数秒かかるため
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
