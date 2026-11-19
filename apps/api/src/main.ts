import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // JSON API: no framework banner, and browsers must not sniff or frame responses.
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  });
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}
void bootstrap();
