import { seed } from "./seed/seed";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}
seed(url)
  .then((s) =>
    console.log(
      `seeded: ${s.created.join(", ") || "-"}; skipped (exists): ${s.skipped.join(", ") || "-"}`,
    ),
  )
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
