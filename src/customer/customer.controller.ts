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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Response } from "express";
import { CustomerService } from "./customer.service";
import { ConversationService } from "../conversation/conversation.service";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { SubscriptionGuard } from "common/subscription.guard";
import { Permissions } from "common/permissions.decorator";
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from "dto/customer.dto";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";

const meAvatarStorage = diskStorage({
  destination: "./uploads/customers",
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `customer-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("customer")
export class CustomerController {
  constructor(
    private readonly customerService: CustomerService,
    private readonly conversationService: ConversationService,
  ) {}

  @Get()
  @Permissions("customer.read")
  findAllPaginated(@Req() req: any, @Query() q: any) {
    return this.customerService.findAllPaginated(req.user, q);
  }

  @Get("stats")
  @Permissions("customer.read")
  getStats(@Req() req: any) {
    return this.customerService.getStats(req.user);
  }

  @Get("export")
  @Permissions("customer.read")
  async exportCustomers(
    @Req() req: any,
    @Res() res: Response,
    @Query() q: any,
  ) {
    const buffer = await this.customerService.exportCustomers(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=customers-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Get("export/addresses")
  @Permissions("customer.read")
  async exportAddresses(
    @Req() req: any,
    @Res() res: Response,
    @Query() q: any,
  ) {
    const buffer = await this.customerService.exportAddresses(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=customer-addresses-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Get(":id/orders/stats")
  @Permissions("customer.read")
  getOrderStats(@Req() req: any, @Param("id") id: string) {
    return this.customerService.getOrderStats(req.user, id);
  }

  @Get(":id")
  @Permissions("customer.read")
  findOne(@Req() req: any, @Param("id") id: string) {
    return this.customerService.findOne(req.user, id);
  }

  @Post()
  @Permissions("customer.create")
  @UseInterceptors(
    FileInterceptor("profilePicture", { storage: meAvatarStorage }),
  )
  create(
    @Req() req: any,
    @Body() payload: CreateCustomerDto,
    @UploadedFile() profilePicture: Express.Multer.File,
  ) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/customers/${profilePicture.filename}`;
    }
    return this.customerService.createCustomer(req.user, payload);
  }

  @Post(":id/conversation")
  @Permissions("conversation.create")
  getOrCreateConversation(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.conversationService.getOrCreateConversationByCustomerId(
      req.user,
      id,
    );
  }

  @Patch(":id")
  @Permissions("customer.update")
  @UseInterceptors(
    FileInterceptor("profilePicture", { storage: meAvatarStorage }),
  )
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() payload: UpdateCustomerDto,
    @UploadedFile() profilePicture: Express.Multer.File,
  ) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/customers/${profilePicture.filename}`;
    } else {
      payload.profilePicture = null;
    }
    return this.customerService.update(req.user, id, payload);
  }

  @Delete(":id")
  @Permissions("customer.delete")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.customerService.remove(req.user, id);
  }

  // ── Customer Addresses ─────────────────────────────────────────

  @Post(":customerId/addresses")
  @Permissions("customer.update")
  createAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Body() payload: CreateCustomerAddressDto,
  ) {
    return this.customerService.createAddress(req.user, customerId, payload);
  }

  @Get(":customerId/addresses")
  @Permissions("customer.read")
  findAllAddresses(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Query() q: any,
  ) {
    return this.customerService.findAllAddresses(req.user, customerId, q);
  }

  @Get(":customerId/addresses/:addressId")
  @Permissions("customer.read")
  findOneAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
  ) {
    return this.customerService.findOneAddress(req.user, customerId, addressId);
  }

  @Patch(":customerId/addresses/:addressId")
  @Permissions("customer.update")
  updateAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
    @Body() payload: UpdateCustomerAddressDto,
  ) {
    return this.customerService.updateAddress(
      req.user,
      customerId,
      addressId,
      payload,
    );
  }

  @Patch(":customerId/addresses/:addressId/default")
  @Permissions("customer.update")
  setDefaultAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
  ) {
    return this.customerService.setDefaultAddress(
      req.user,
      customerId,
      addressId,
    );
  }

  @Delete(":customerId/addresses/:addressId/default")
  @Permissions("customer.update")
  removeDefaultAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
  ) {
    return this.customerService.removeDefaultAddress(
      req.user,
      customerId,
      addressId,
    );
  }

  @Delete(":customerId/addresses/:addressId")
  @Permissions("customer.update")
  removeAddress(
    @Req() req: any,
    @Param("customerId") customerId: string,
    @Param("addressId") addressId: string,
  ) {
    return this.customerService.removeAddress(
      req.user,
      customerId,
      addressId,
    );
  }
}
