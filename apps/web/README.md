# apps/web: booking page and dashboard (M7)

Next.js (App Router) + Ant Design. The browser only calls `/api/*`; `next.config.mjs` rewrites it to the Nest API
(`API_URL`, default `http://localhost:3000`), so there is no CORS setup.

| Page         | What it does                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Public booking: branch, service, day, free slot, customer, confirm (idempotency key per click). Chat box with the AI assistant. |
| `/dashboard` | Week view per branch, customer search, confirm / check-in / no-show / complete / cancel, reschedule from live availability.     |
| `/waitlist`  | Queue per branch and status; leave the queue.                                                                                   |
| `/admin`     | Create and delete branches, services, staff, customers.                                                                         |
| `/simulator` | Fires N concurrent bookings at one slot: exactly one succeeds, the rest get 409.                                                |

## Run

```bash
pnpm --filter @slotflow/api seed      # prints the tenant ids
pnpm --filter @slotflow/api dev       # API on :3000
pnpm --filter @slotflow/web dev       # web on :3001; paste a tenant id in the top bar
```

## Known gaps

No login yet: the tenant id is typed in (dev only) and the customer is picked from a list, to be replaced by JWT.
Reschedule uses a dialog, not drag and drop. Working hours and time off are API-only. No monitoring or
notification pages: the API has no endpoints for them yet.
