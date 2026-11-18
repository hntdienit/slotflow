import { migrate } from "./db/migrate";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}
migrate(url)
  .then((applied) => console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
