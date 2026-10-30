import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig so tests import app modules
    // exactly the way the application does.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
