import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/** Fresh `slotflow_worker_test` database with the API's migrations applied. */
export default async function setup() {
  // The queue tests need a real SQS/SES endpoint: LocalStack (pinned localstack/localstack:4.12 in compose and CI).
  const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
  const ok = await fetch(`${endpoint}/_localstack/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (!ok)
    throw new Error(
      `LocalStack is not reachable at ${endpoint}; start it (docker compose up localstack) or set AWS_ENDPOINT_URL`,
    );
  process.env.AWS_ENDPOINT_URL = endpoint;
  const base = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
  const name = "slotflow_worker_test";
  const root = new Client({ connectionString: base });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  const dir = path.resolve(__dirname, "../../api/migrations");
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await c.query(readFileSync(path.join(dir, f), "utf8"));
  await c.end();
  process.env.TEST_DB_ADMIN_URL = url.toString();
  const w = new URL(url.toString());
  w.username = "slotflow_worker";
  w.password = "slotflow_worker";
  process.env.TEST_DB_WORKER_URL = w.toString();
}
