import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { TenantId } from "../tenant.decorator";
import { CatalogService } from "./catalog.service";

@Controller("admin")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("staff/:id/branches")
  getBranches(@TenantId() t: string, @Param("id") id: string) {
    return this.catalog.getStaffLinks(t, id, "branches");
  }
  @Put("staff/:id/branches")
  setBranches(@TenantId() t: string, @Param("id") id: string, @Body() body: unknown) {
    return this.catalog.setStaffLinks(t, id, "branches", body);
  }
  @Get("staff/:id/services")
  getServices(@TenantId() t: string, @Param("id") id: string) {
    return this.catalog.getStaffLinks(t, id, "services");
  }
  @Put("staff/:id/services")
  setServices(@TenantId() t: string, @Param("id") id: string, @Body() body: unknown) {
    return this.catalog.setStaffLinks(t, id, "services", body);
  }

  @Get(":entity")
  list(@TenantId() t: string, @Param("entity") e: string, @Query() q: Record<string, string>) {
    return this.catalog.list(t, e, q);
  }
  @Post(":entity")
  create(@TenantId() t: string, @Param("entity") e: string, @Body() body: unknown) {
    return this.catalog.create(t, e, body);
  }
  @Get(":entity/:id")
  get(@TenantId() t: string, @Param("entity") e: string, @Param("id") id: string) {
    return this.catalog.get(t, e, id);
  }
  @Patch(":entity/:id")
  update(
    @TenantId() t: string,
    @Param("entity") e: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.update(t, e, id, body);
  }
  @Delete(":entity/:id")
  @HttpCode(204)
  async remove(@TenantId() t: string, @Param("entity") e: string, @Param("id") id: string) {
    await this.catalog.remove(t, e, id);
  }
}
