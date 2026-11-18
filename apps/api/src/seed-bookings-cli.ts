import { seedBookings } from "./seed/seed-bookings";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}
seedBookings(url)
  .then((n) => console.log(`seeded ${n} fake bookings`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
