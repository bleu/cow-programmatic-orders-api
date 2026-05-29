import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    alias: [
      // ponder:schema must come before ponder to avoid prefix-match shadowing.
      { find: "ponder:schema", replacement: resolve(__dirname, "tests/__mocks__/ponder-schema.ts") },
      { find: /^ponder$/, replacement: resolve(__dirname, "tests/__mocks__/ponder.ts") },
    ],
  },
});
