const adminBase = process.env.E2E_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const db = "slotflow_e2e";
const withDb = (user?: string, pass?: string) => {
  const u = new URL(adminBase);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = pass ?? user;
  }
  return u.toString();
};

export const E2E = {
  db,
  adminBase,
  adminUrl: withDb(),
  appUrl: withDb("slotflow_app"),
  apiPort: 3100,
  webPort: 3101,
  api: "http://localhost:3100",
  web: "http://localhost:3101",
};
