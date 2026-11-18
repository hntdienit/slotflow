import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

async function appWith(report: { postgres: boolean; redis: boolean }) {
  const mod = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: HealthService,
        useValue: {
          check: async () => ({
            status: report.postgres && report.redis ? "ok" : "degraded",
            ...report,
          }),
        },
      },
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe("GET /health", () => {
  it("returns 200 when everything is up", async () => {
    const app = await appWith({ postgres: true, redis: true });
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    await app.close();
  });
  it("returns 200 degraded when only Redis is down (Postgres is the source of truth)", async () => {
    const app = await appWith({ postgres: true, redis: false });
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    await app.close();
  });
  it("returns 503 when Postgres is down", async () => {
    const app = await appWith({ postgres: false, redis: true });
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(503);
    await app.close();
  });
});
