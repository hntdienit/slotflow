import { expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { E2E } from "../env";

export const tenant = () =>
  JSON.parse(readFileSync(path.join(__dirname, "../.tenant.json"), "utf8")) as {
    id: string;
    name: string;
  };

export async function api<T>(
  p: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${E2E.api}${p}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "x-tenant-id": tenant().id, "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Opens the app with the tenant already chosen, as a person would after pasting the id. */
export async function open(page: Page, url: string) {
  await page.addInitScript((id) => localStorage.setItem("slotflow.tenantId", id), tenant().id);
  await page.goto(url);
}

export const ymd = (daysAhead: number) =>
  new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

/** First day (from tomorrow) with free slots for this branch and service. */
export async function firstFreeDay(branchId: string, serviceId: string) {
  for (let d = 1; d <= 10; d++) {
    const day = ymd(d);
    const r = await api<{ slots: { startAt: string; staffId: string }[] }>(
      `/branches/${branchId}/availability?serviceId=${serviceId}&from=${day}&to=${day}`,
    );
    if (r.slots.length > 2) return { day, slots: r.slots };
  }
  throw new Error("no free day in the next 10 days");
}

export async function choose(page: Page, label: string, option: string | RegExp) {
  await page.locator(".ant-form-item", { hasText: label }).locator(".ant-select").first().click();
  await pick(page, option);
}

/** Closed dropdowns stay in the DOM (hidden), so only look inside the one that is open. */
export async function pick(page: Page, option: string | RegExp) {
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", {
      hasText: option,
    })
    .first()
    .click();
  // Single selects close on pick; waiting for that keeps the next dropdown from racing this one's exit animation.
  await expect(page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).toHaveCount(
    0,
  );
}

export async function setDate(page: Page, day: string) {
  const input = page.locator(".ant-picker input").first();
  await input.fill(day);
  await input.press("Enter");
  // The calendar popup can stay open and would cover whatever the next step clicks.
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)")).toHaveCount(
    0,
  );
}

let n = 0;
/** Frames for the demo GIF; harmless when not wanted. */
export async function frame(page: Page, name: string) {
  const dir = path.join(__dirname, "../frames");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${String(++n).padStart(2, "0")}-${name}.png`) });
}

export { expect };
