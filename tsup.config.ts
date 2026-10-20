import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      wraps: "src/wraps.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    // clean is done in the build script — with parallel configs, tsup's
    // own clean races the other config's output and can delete emitted files
    clean: false,
    external: ["@wraps.dev/email", "vitest"],
  },
  {
    // ESM only: vitest throws when it's require()d
    entry: { testing: "src/testing.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    external: ["@wraps.dev/email", "vitest"],
  },
]);
