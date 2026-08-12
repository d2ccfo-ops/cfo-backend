import { defineConfig } from "vitest/config";

// Unit tests only — anything needing the live Postgres/Redis instance is a
// scripts/check*.ts integration script (npm run check:integration), kept
// deliberately separate so `npm test` can run in CI with no database at all.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
