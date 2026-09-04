import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AudienceService } from "./audience.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import { ClientAudienceFilter } from "common/client-audience-filter.types";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("audience-filter")
export class AudienceController {
  constructor(
    private readonly audienceService: AudienceService,
    private readonly translations: TranslationService,
  ) {}

  @Permissions("client-segments.read")
  @Get("entities")
  entities() {
    return this.audienceService.getFilterMetadata();
  }

  @Permissions("client-segments.preview")
  @Post("recipients")
  recipients(@Req() req: any, @Body() filter: ClientAudienceFilter, @Query() q: any) {
    const adminId = tenantId(req.user);
    if (!adminId) {
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    }

    return this.audienceService.listRecipients(adminId, filter, {
      cursor: q?.cursor,
      limit: Number(q?.limit ?? 10),
      sortDir: String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC",
    });
  }
}
