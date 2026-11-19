import { listTenants, seed } from "./seed/seed";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}
seed(url)
  .then(async (s) => {
    console.log(
      `seeded: ${s.created.join(", ") || "-"}; skipped (exists): ${s.skipped.join(", ") || "-"}`,
    );
    for (const t of await listTenants(url)) console.log(`tenant ${t.id}  ${t.name}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
