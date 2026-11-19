import { api, expect, pick, ymd, firstFreeDay, frame, open, setDate } from "./helpers";
import { test } from "@playwright/test";

test("40 simultaneous bookings for one slot: exactly one wins", async ({ page }) => {
  const branch = (await api<{ items: { id: string; name: string }[] }>("/admin/branches"))
    .items[0]!;
  const service = (await api<{ items: { id: string; name: string }[] }>("/admin/services"))
    .items[0]!;
  const { day } = await firstFreeDay(branch.id, service.id);

  await open(page, "/simulator");
  const selects = page.locator(".ant-select");
  // Each step waits for its own result before the next one, so a slow dropdown animation cannot swallow a click.
  const select = async (n: number, option: string | RegExp, shown?: string) => {
    await selects.nth(n).click();
    await pick(page, option);
    if (shown) await expect(selects.nth(n)).toContainText(shown);
  };
  await select(0, branch.name, branch.name);
  const availability = () =>
    page.waitForResponse((r) => r.url().includes("/availability") && r.ok());
  const first = availability(); // choosing the service loads the default day (tomorrow)
  await select(1, service.name, service.name);
  await first;
  if (day !== ymd(1)) {
    const again = availability();
    await setDate(page, day);
    await again;
  }
  await select(2, /./, ":");
  await page.locator(".ant-input-number input").fill("40");
  await frame(page, "simulator-ready");
  await page.getByRole("button", { name: "Bắn!" }).click();

  const stat = (title: string) =>
    page.locator(".ant-statistic", { hasText: title }).locator(".ant-statistic-content-value");
  await expect(stat("Thành công")).toHaveText("1");
  await expect(stat("Bị từ chối (409)")).toHaveText("39");
  await expect(stat("Lỗi khác")).toHaveText("0");
  await frame(page, "simulator-result");
});
