import { api, expect, pick, firstFreeDay, frame, open, setDate } from "./helpers";
import { test } from "@playwright/test";

test("a manager reschedules a booking from the week view", async ({ page }) => {
  const branch = (await api<{ items: { id: string; name: string }[] }>("/admin/branches"))
    .items[1]!;
  const service = (await api<{ items: { id: string; name: string }[] }>("/admin/services"))
    .items[0]!;
  const customer = (
    await api<{ items: { id: string; fullName: string }[] }>("/admin/customers?limit=5")
  ).items[0]!;
  const { day, slots } = await firstFreeDay(branch.id, service.id);
  const first = slots[0]!;
  const created = await api<{ id: string; startAt: string }>("/bookings", {
    body: {
      branchId: branch.id,
      serviceId: service.id,
      customerId: customer.id,
      startAt: first.startAt,
      staffId: first.staffId,
      source: "admin",
    },
  });

  await open(page, "/dashboard");
  await page.locator(".ant-select").first().click();
  await pick(page, branch.name);
  await setDate(page, day);
  const card = page.locator(".ant-card .ant-card", { hasText: customer.fullName }).first();
  await expect(card).toBeVisible();
  await frame(page, "week");
  await card.getByRole("button", { name: "reschedule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".ant-tag-checkable").nth(3).click();
  await frame(page, "reschedule");
  await dialog.getByRole("button", { name: "Đổi" }).click();
  await expect(page.getByText("Đã đổi lịch")).toBeVisible();

  const moved = await api<{ startAt: string; status: string }>(`/bookings/${created.id}`);
  expect(moved.startAt).not.toBe(created.startAt);
  expect(moved.status).toBe("confirmed");
});
