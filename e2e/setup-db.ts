import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { E2E } from "./env";

/**
 * Runs before `playwright test` (see the pretest script): Playwright starts its web servers before any global
 * setup, and the API's /health needs the database to exist. Fresh database, migrated and seeded with the fake clinics, before every run. The web app proxies /api to the
 * API on E2E.apiPort, which is baked in at `next build`, so build with API_URL=http://localhost:3100 first.
 */
async function setup() {
  const root = new Client({ connectionString: E2E.adminBase });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${E2E.db} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${E2E.db}`);
  await root.end();

  const cwd = path.resolve(__dirname, "../apps/api");
  const env = { ...process.env, DATABASE_ADMIN_URL: E2E.adminUrl };
  execFileSync("node", ["dist/migrate-cli.js"], { cwd, env, stdio: "inherit" });
  const out = execFileSync("node", ["dist/seed-cli.js"], { cwd, env }).toString();
  const tenants = [...out.matchAll(/^tenant (\S+)\s+(.+)$/gm)].map((m) => ({
    id: m[1]!,
    name: m[2]!,
  }));
  if (!tenants.length) throw new Error(`seed printed no tenants:\n${out}`);
  writeFileSync(path.join(__dirname, ".tenant.json"), JSON.stringify(tenants[0]));
}

setup().catch((e) => {
  console.error(e);
  process.exit(1);
});
