import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { GettingStartedStatsService } from "./getting-started-stats.service";

@UseGuards(JwtAuthGuard)
@Controller("getting-started/admin/stats")
export class GettingStartedStatsController {
  constructor(
    private readonly statsService: GettingStartedStatsService,
  ) { }

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

  // ---------- Single user statistics ----------

  /**
   * GET /getting-started/admin/stats/user/:userId/overview
   * Returns a summary of the user’s progress across all items.
   */
  @Permissions("getting-started.stats")
  @Get("user/:userId/overview")
  userOverview(@Req() req: any, @Param("userId") userId: string) {
    return this.statsService.getUserOverview(req.user, userId);
  }

  /**
   * GET /getting-started/admin/stats/user/:userId/items
   * Returns per‑item progress (completed, started, skipped, timestamps) for the user.
   */
  @Permissions("getting-started.stats")
  @Get("user/:userId/items")
  userItems(@Req() req: any, @Param("userId") userId: string) {
    return this.statsService.getUserItemStats(req.user, userId);
  }

  /**
   * GET /getting-started/admin/stats/user/:userId/steps
   * Returns per‑step interaction data (viewed, skipped, last view time) for the user.
   */
  @Permissions("getting-started.stats")
  @Get("user/:userId/steps")
  userSteps(@Req() req: any, @Param("userId") userId: string) {
    return this.statsService.getUserStepStats(req.user, userId);
  }
}
