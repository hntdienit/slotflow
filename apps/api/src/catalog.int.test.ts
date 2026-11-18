import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogModule } from "./catalog/catalog.module";
import { CacheModule } from "./cache/cache.module";
import { DbModule } from "./db/db.module";
import { createTenant } from "../test/helpers";

describe("catalog CRUD (HTTP, real Postgres + RLS)", () => {
  let app: INestApplication;
  let a: string;
  let b: string;
  const http = () => request(app.getHttpServer());
  const as = (t: string) => ({ "x-tenant-id": t });

  beforeAll(async () => {
    a = await createTenant("crud-a");
    b = await createTenant("crud-b");
    const mod = await Test.createTestingModule({
      imports: [DbModule, CacheModule, CatalogModule],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it("requires a tenant header", async () => {
    expect((await http().get("/admin/branches")).status).toBe(401);
    expect((await http().get("/admin/branches").set("x-tenant-id", "nope")).status).toBe(401);
  });

  it("branch lifecycle: create, get, list, patch, delete", async () => {
    const created = await http()
      .post("/admin/branches")
      .set(as(a))
      .send({ name: "Q1", timezone: "Asia/Ho_Chi_Minh", address: "1 Le Loi" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Q1", timezone: "Asia/Ho_Chi_Minh", tenantId: a });
    const id = created.body.id as string;

    expect((await http().get(`/admin/branches/${id}`).set(as(a))).body.name).toBe("Q1");
    expect((await http().get("/admin/branches").set(as(a))).body.items).toHaveLength(1);

    const patched = await http()
      .patch(`/admin/branches/${id}`)
      .set(as(a))
      .send({ name: "Q1 Renamed" });
    expect(patched.body.name).toBe("Q1 Renamed");

    expect((await http().delete(`/admin/branches/${id}`).set(as(a))).status).toBe(204);
    expect((await http().get(`/admin/branches/${id}`).set(as(a))).status).toBe(404);
  });

  it("validates input", async () => {
    const bad = await http()
      .post("/admin/branches")
      .set(as(a))
      .send({ name: "x", timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    expect(
      (await http().post("/admin/services").set(as(a)).send({ name: "s", durationMin: 1 })).status,
    ).toBe(400);
    expect((await http().get("/admin/branches/not-a-uuid").set(as(a))).status).toBe(400);
    expect((await http().get("/admin/unknown").set(as(a))).status).toBe(404);
  });

  it("isolates tenants over HTTP", async () => {
    const mine = await http()
      .post("/admin/branches")
      .set(as(a))
      .send({ name: "A only", timezone: "UTC" });
    const id = mine.body.id as string;
    expect((await http().get(`/admin/branches/${id}`).set(as(b))).status).toBe(404);
    expect(
      (await http().patch(`/admin/branches/${id}`).set(as(b)).send({ name: "x" })).status,
    ).toBe(404);
    expect((await http().delete(`/admin/branches/${id}`).set(as(b))).status).toBe(404);
    const listB = await http().get("/admin/branches").set(as(b));
    expect(listB.body.items).toHaveLength(0);
  });

  it("resources, staff links and working hours", async () => {
    const branch = (
      await http()
        .post("/admin/branches")
        .set(as(a))
        .send({ name: "R", timezone: "Asia/Ho_Chi_Minh" })
    ).body;
    const room = await http()
      .post("/admin/resources")
      .set(as(a))
      .send({ branchId: branch.id, type: "room", name: "Room 1" });
    expect(room.status).toBe(201);
    const filtered = await http().get(`/admin/resources?branchId=${branch.id}`).set(as(a));
    expect(filtered.body.items).toHaveLength(1);

    const svc = (
      await http()
        .post("/admin/services")
        .set(as(a))
        .send({ name: "Khám", durationMin: 30, bufferAfterMin: 5, priceCents: 1000 })
    ).body;
    expect(svc).toMatchObject({ durationMin: 30, bufferAfterMin: 5, cancelWindowHours: 24 });
    const st = (await http().post("/admin/staff").set(as(a)).send({ fullName: "Dr. An" })).body;

    const links = await http()
      .put(`/admin/staff/${st.id}/branches`)
      .set(as(a))
      .send({ branchIds: [branch.id] });
    expect(links.body.branchIds).toEqual([branch.id]);
    await http()
      .put(`/admin/staff/${st.id}/services`)
      .set(as(a))
      .send({ serviceIds: [svc.id] });
    expect((await http().get(`/admin/staff/${st.id}/services`).set(as(a))).body.serviceIds).toEqual(
      [svc.id],
    );

    // another tenant's branch cannot be linked
    const foreign = (
      await http().post("/admin/branches").set(as(b)).send({ name: "B", timezone: "UTC" })
    ).body;
    const cross = await http()
      .put(`/admin/staff/${st.id}/branches`)
      .set(as(a))
      .send({ branchIds: [foreign.id] });
    expect(cross.status).toBe(422);

    const wh = await http().post("/admin/working-hours").set(as(a)).send({
      ownerType: "staff",
      ownerId: st.id,
      weekday: 1,
      startLocal: "09:00",
      endLocal: "17:00",
    });
    expect(wh.status).toBe(201);
    const badRange = await http().post("/admin/working-hours").set(as(a)).send({
      ownerType: "staff",
      ownerId: st.id,
      weekday: 1,
      startLocal: "17:00",
      endLocal: "09:00",
    });
    expect(badRange.status).toBe(400);
    const ghostOwner = await http()
      .post("/admin/working-hours")
      .set(as(a))
      .send({
        ownerType: "staff",
        ownerId: st.id.replace(/.$/, "0"),
        weekday: 1,
        startLocal: "09:00",
        endLocal: "10:00",
      });
    expect(ghostOwner.status).toBe(422);

    const off = await http().post("/admin/time-off").set(as(a)).send({
      ownerType: "staff",
      ownerId: st.id,
      startAt: "2026-12-24T00:00:00Z",
      endAt: "2026-12-26T00:00:00Z",
      reason: "Tết dương",
    });
    expect(off.status).toBe(201);

    // deleting a service that is linked cascades the link, deleting a branch with resources cascades resources
    expect((await http().delete(`/admin/branches/${branch.id}`).set(as(a))).status).toBe(204);
    expect(
      (await http().get(`/admin/resources?branchId=${branch.id}`).set(as(a))).body.items,
    ).toHaveLength(0);
  });

  it("maps unique violations to 409", async () => {
    const body = { fullName: "Dup", email: "dup@example.com" };
    expect((await http().post("/admin/customers").set(as(a)).send(body)).status).toBe(201);
    expect((await http().post("/admin/customers").set(as(a)).send(body)).status).toBe(409);
    // same email in another tenant is fine
    expect((await http().post("/admin/customers").set(as(b)).send(body)).status).toBe(201);
  });
});
