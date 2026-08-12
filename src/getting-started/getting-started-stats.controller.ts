import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { GettingStartedStatsService } from "./getting-started-stats.service";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("getting-started/admin/stats")
export class GettingStartedStatsController {
  constructor(
    private readonly statsService: GettingStartedStatsService,
  ) {}

  @Permissions("getting-started.stats")
  @Get("overview")
  overview(@Req() req: any) {
    return this.statsService.getOverview(req.user);
  }

  @Permissions("getting-started.stats")
  @Get("items")
  items(@Req() req: any) {
    return this.statsService.getItemStats(req.user);
  }

  @Permissions("getting-started.stats")
  @Get("steps")
  steps(@Req() req: any) {
    return this.statsService.getStepStats(req.user);
  }
}
