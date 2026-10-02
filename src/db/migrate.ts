// Tiny runner for schema.sql — no migration framework. Run with:
//   npm run db:migrate          (dev, via ts-node)
//   npm run db:migrate:build    (after `npm run build`, against the compiled dist/)
// Safe to run multiple times (schema.sql is all IF NOT EXISTS).

import fs from "fs";
import path from "path";
import { pool } from "./pool";

async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Applying schema from ${schemaPath} ...`);
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log("Schema applied.");
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
