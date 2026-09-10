import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { SubscriptionGuard } from "common/subscription.guard";
import { Permissions } from "common/permissions.decorator";
import { Response } from "express";
import {
  CreateAssigningRuleDto,
  PreviewAssigningDto,
  ResolveAssigningDto,
  UpdateAssigningRuleDto,
} from "dto/shipping-assigning.dto";
import { ShippingAssigningService } from "./shipping-assigning.service";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("shipping-assigning")
export class ShippingAssigningController {
  constructor(
    private readonly shippingAssigningService: ShippingAssigningService,
  ) {}

  @Permissions("shipping-assigning.read")
  @Get("rules")
  listRules(@Req() req: any, @Query() q: any) {
    return this.shippingAssigningService.listRules(req.user, q);
  }

  @Permissions("shipping-assigning.read")
  @Get("rules/stats")
  getRulesStats(@Req() req: any) {
    return this.shippingAssigningService.getRulesStats(req.user);
  }

  @Permissions("shipping-assigning.read")
  @Get("rules/export")
  async exportRules(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.shippingAssigningService.exportRules(
      req.user,
      q,
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=shipping_assigning_rules_${Date.now()}.xlsx`,
    );
    return res.send(buffer);
  }

  @Permissions("shipping-assigning.create")
  @Post("rules")
  createRule(@Req() req: any, @Body() dto: CreateAssigningRuleDto) {
    return this.shippingAssigningService.createRule(req.user, dto);
  }

  @Permissions("shipping-assigning.read")
  @Get("rules/:id")
  getRuleDetails(@Req() req: any, @Param("id") id: string) {
    return this.shippingAssigningService.getRuleDetails(req.user, id);
  }

  @Permissions("shipping-assigning.update")
  @Patch("rules/:id")
  updateRule(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateAssigningRuleDto,
  ) {
    return this.shippingAssigningService.updateRule(req.user, id, dto);
  }

  @Permissions("shipping-assigning.update")
  @Post("rules/:id/toggle")
  toggleRuleActive(@Req() req: any, @Param("id") id: string) {
    return this.shippingAssigningService.toggleRuleActive(req.user, id);
  }

  @Permissions("shipping-assigning.delete")
  @Delete("rules/:id")
  deleteRule(@Req() req: any, @Param("id") id: string) {
    return this.shippingAssigningService.deleteRule(req.user, id);
  }

  // =========================================================================
  // Resolve + preview (no mutation of orders/shipments)
  // =========================================================================

  @Permissions("shipping-assigning.read")
  @Post("resolve")
  resolve(@Req() req: any, @Body() dto: ResolveAssigningDto) {
    return this.shippingAssigningService.resolve(req.user, dto);
  }

  @Permissions("shipping-assigning.read")
  @Post("preview")
  preview(@Req() req: any, @Body() dto: PreviewAssigningDto) {
    return this.shippingAssigningService.preview(req.user, dto);
  }
}
