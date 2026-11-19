import { api, choose, expect, firstFreeDay, frame, open, setDate } from "./helpers";
import { test } from "@playwright/test";

interface Row {
  id: string;
  name: string;
}

test("a customer books a slot from the public page, then the assistant books another", async ({
  page,
}) => {
  const branches = (await api<{ items: Row[] }>("/admin/branches")).items;
  const services = (await api<{ items: (Row & { durationMin: number })[] }>("/admin/services"))
    .items;
  const branch = branches[0]!;
  const service = services[0]!;
  const { day, slots } = await firstFreeDay(branch.id, service.id);

  await open(page, "/");
  await choose(page, "Chi nhánh", branch.name);
  await choose(page, "Dịch vụ", service.name);
  await setDate(page, day);
  await expect(page.locator(".ant-tag-checkable").first()).toBeVisible();
  await frame(page, "free-slots");
  await page.locator(".ant-tag-checkable").first().click();
  await choose(page, "Khách", /./);
  await page.getByRole("button", { name: "Xác nhận đặt lịch" }).click();
  await expect(page.getByText("Mã lịch hẹn:")).toBeVisible();
  await frame(page, "booked");

  const bookings = await api<{ source: string; status: string; startAt: string }[]>(
    `/bookings?branchId=${branch.id}&from=${day}T00:00:00Z&to=${day}T23:59:59Z&limit=200`,
  );
  expect(bookings.filter((b) => b.source === "web" && b.status === "confirmed")).toHaveLength(1);

  // The same page, asking the assistant. The server must wait for an explicit "yes".
  const chat = page.locator(".ant-card", { hasText: "Trợ lý đặt lịch" });
  const say = async (text: string) => {
    await chat.getByRole("textbox").fill(text);
    await chat.getByRole("button", { name: "Gửi" }).click();
  };
  const d = new Date(`${day}T00:00:00Z`);
  const [dd, mm] = [String(d.getUTCDate()), String(d.getUTCMonth() + 1)];
  await say(`đặt ${service.name} tại ${branch.name} ngày ${dd}/${mm}/${d.getUTCFullYear()}`);
  await expect(chat.getByText("Bạn chọn số mấy?")).toBeVisible();
  await say("2");
  await expect(chat.getByText(/Bạn xác nhận chứ/)).toBeVisible();
  const before = (await api<unknown[]>(`/bookings?branchId=${branch.id}&limit=200`)).length;
  await frame(page, "assistant-confirm");
  await say("có");
  await expect(chat.getByText(/Đã đặt lịch/)).toBeVisible();
  await frame(page, "assistant-booked");
  const after = await api<{ source: string }[]>(`/bookings?branchId=${branch.id}&limit=200`);
  expect(after.length).toBe(before + 1);
  expect(after.filter((b) => b.source === "ai")).toHaveLength(1);
  expect(slots.length).toBeGreaterThan(2);
});
