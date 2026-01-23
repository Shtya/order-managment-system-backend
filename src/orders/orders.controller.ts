// orders/orders.controller.ts
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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { OrdersService } from "./orders.service";
import {
  CreateOrderDto,
  UpdateOrderDto,
  ChangeOrderStatusDto,
  UpdatePaymentStatusDto,
  AddOrderMessageDto,
  MarkMessagesReadDto,
} from "dto/order.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("orders")
export class OrdersController {
  constructor(private svc: OrdersService) {}

  // ✅ Get order statistics
  @Permissions("orders.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.svc.getStats(req.user);
  }

  // ✅ List orders with filters
  @Permissions("orders.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  // ✅ Get single order
  @Permissions("orders.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.svc.get(req.user, Number(id));
  }

  // ✅ Create new order
  @Permissions("orders.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateOrderDto) {
    return this.svc.create(req.user, dto, req.ip);
  }

  // ✅ Update order
  @Permissions("orders.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateOrderDto) {
    return this.svc.update(req.user, Number(id), dto, req.ip);
  }

  // ✅ Change order status
  @Permissions("orders.update")
  @Patch(":id/status")
  changeStatus(@Req() req: any, @Param("id") id: string, @Body() dto: ChangeOrderStatusDto) {
    return this.svc.changeStatus(req.user, Number(id), dto, req.ip);
  }

  // ✅ Update payment status
  @Permissions("orders.update")
  @Patch(":id/payment-status")
  updatePaymentStatus(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdatePaymentStatusDto
  ) {
    return this.svc.updatePaymentStatus(req.user, Number(id), dto);
  }

  @Permissions("orders.read")
  @Get(":id/messages")
  getMessages(@Req() req: any, @Param("id") id: string) {
    return this.svc.getMessages(req.user, Number(id));
  }


  @Permissions("orders.update")
  @Post(":id/messages")
  addMessage(@Req() req: any, @Param("id") id: string, @Body() dto: AddOrderMessageDto) {
    return this.svc.addMessage(req.user, Number(id), dto);
  }

	
  @Permissions("orders.update")
  @Patch(":id/messages/read")
  markMessagesRead(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: MarkMessagesReadDto
  ) {
    return this.svc.markMessagesRead(req.user, Number(id), dto);
  }

  // ✅ Delete order
  @Permissions("orders.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.svc.remove(req.user, Number(id));
  }
}