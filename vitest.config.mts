import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], environment: "node", setupFiles: ["tests/setup.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
