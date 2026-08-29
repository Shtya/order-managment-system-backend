import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { OrderInternalNotesService } from "../services/order-internal-notes.service";
import { CreateOrderInternalNoteDto } from "dto/order.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("orders/:orderId/internal-notes")
@RequireSubscription()
export class OrderInternalNotesController {
  constructor(private readonly svc: OrderInternalNotesService) {}

  @Permissions("orders.internalNotes")
  @Get()
  list(
    @Req() req: any,
    @Param("orderId") orderId: string,
    @Query() q: any,
  ) {
    return this.svc.list(req.user, orderId, q);
  }

  @Permissions("orders.internalNotes")
  @Post()
  add(
    @Req() req: any,
    @Param("orderId") orderId: string,
    @Body() dto: CreateOrderInternalNoteDto,
  ) {
    return this.svc.add(req.user, orderId, dto);
  }

  @Permissions("orders.internalNotes")
  @Patch("read")
  markRead(@Req() req: any, @Param("orderId") orderId: string) {
    return this.svc.markRead(req.user, orderId);
  }
}
