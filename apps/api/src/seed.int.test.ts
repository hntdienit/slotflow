import { describe, expect, it } from "vitest";
import { seed, TENANTS } from "./seed/seed";
import { admin } from "../test/helpers";

describe("clinic seed", () => {
  it("creates 3 tenants, 6 branches in 2 timezones, 30 staff; second run is a no-op", async () => {
    const first = await seed(process.env.DATABASE_ADMIN_URL!);
    expect(first.created).toHaveLength(3);
    const second = await seed(process.env.DATABASE_ADMIN_URL!);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);

    const slugs = TENANTS.map((t) => t.slug);
    const stats = await admin(async (c) => {
      const q = async (sql: string) => (await c.query(sql, [slugs])).rows;
      return {
        branches: await q(
          "SELECT count(*)::int n, count(DISTINCT timezone)::int tz FROM branches b JOIN tenants t ON t.id=b.tenant_id WHERE t.slug = ANY($1)",
        ),
        staff: await q(
          "SELECT count(*)::int n FROM staff s JOIN tenants t ON t.id=s.tenant_id WHERE t.slug = ANY($1)",
        ),
        // every staff member has a schedule, branches, and >=1 service
        orphans: await q(`SELECT count(*)::int n FROM staff s JOIN tenants t ON t.id=s.tenant_id
          WHERE t.slug = ANY($1) AND (
            NOT EXISTS (SELECT 1 FROM staff_branches x WHERE x.staff_id=s.id) OR
            NOT EXISTS (SELECT 1 FROM staff_services x WHERE x.staff_id=s.id) OR
            NOT EXISTS (SELECT 1 FROM working_hours w WHERE w.owner_id=s.id))`),
      };
    });
    expect(stats.branches[0]).toEqual({ n: 6, tz: 2 });
    expect(stats.staff[0].n).toBe(30);
    expect(stats.orphans[0].n).toBe(0);
  });
});
