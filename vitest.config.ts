import { defineConfig } from "vitest/config";

// Unit tests only — anything needing the live Postgres/Redis instance is a
// scripts/check*.ts integration script (npm run check:integration), kept
// deliberately separate so `npm test` can run in CI with no database at all.
export default defineConfig({
  test: {
    // eval/ is included because the GRADER is pure and needs testing: a
    // grader that marks a bad answer correct produces a green percentage
    // that stops anyone looking, which is worse than having no eval. The
    // eval RUNNER still needs a database and a key, and is not a test.
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
  },
});
