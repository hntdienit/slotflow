import { Client } from "pg";
import { migrate } from "../src/db/migrate";

/** Creates a fresh `slotflow_test` database, migrates it and exports connection URLs for the tests. */
export default async function setup() {
  const adminBase = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
  const dbName = "slotflow_test";
  const root = new Client({ connectionString: adminBase });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();

  const adminUrl = new URL(adminBase);
  adminUrl.pathname = `/${dbName}`;
  await migrate(adminUrl.toString());

  const appUrl = new URL(adminUrl.toString());
  appUrl.username = "slotflow_app";
  appUrl.password = "slotflow_app";
  process.env.DATABASE_ADMIN_URL = adminUrl.toString();
  process.env.DATABASE_URL = appUrl.toString();
}
