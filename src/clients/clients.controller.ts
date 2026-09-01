import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { SubscriptionGuard } from "common/subscription.guard";
import { Permissions } from "common/permissions.decorator";
import {
  CreateClientAddressDto,
  CreateClientDto,
  LinkClientContactDto,
  UpdateClientAddressDto,
  UpdateClientDto,
} from "dto/client.dto";
import { ClientService } from "./clients.service";
import { Response } from "express";

const clientAvatarStorage = diskStorage({
  destination: "./uploads/clients",
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `client-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("clients")
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Get()
  @Permissions("customer.read")
  findAllPaginated(@Req() req: any, @Query() q: any) {
    return this.clientService.findAllPaginated(req.user, q);
  }

  @Get("list")
  @Permissions("customer.read")
  list(@Req() req: any, @Query() q: any) {
    return this.clientService.list(req.user, q);
  }

  @Get("stats")
  @Permissions("customer.read")
  getStats(@Req() req: any) {
    return this.clientService.getStats(req.user);
  }

  @Get("export")
  @Permissions("customer.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async exportClients(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.clientService.exportClients(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=clients-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Get(":id/orders/stats")
  @Permissions("customer.read", "orders.confirm-incoming")
  getOrderStats(@Req() req: any, @Param("id") id: string) {
    return this.clientService.getOrderStats(req.user, id);
  }

  @Get(":id")
  @Permissions("customer.read", "orders.confirm-incoming")
  findOne(@Req() req: any, @Param("id") id: string) {
    return this.clientService.findOne(req.user, id);
  }

  @Post()
  @Permissions("customer.create")
  @UseInterceptors(FileInterceptor("profilePicture", { storage: clientAvatarStorage }))
  create(
    @Req() req: any,
    @Body() payload: CreateClientDto,
    @UploadedFile() profilePicture: Express.Multer.File,
  ) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/clients/${profilePicture.filename}`;
    }
    return this.clientService.create(req.user, payload);
  }

  @Patch(":id")
  @Permissions("customer.update")
  @UseInterceptors(FileInterceptor("profilePicture", { storage: clientAvatarStorage }))
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() payload: UpdateClientDto,
    @UploadedFile() profilePicture: Express.Multer.File,
  ) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/clients/${profilePicture.filename}`;
    }
    return this.clientService.update(req.user, id, payload);
  }

  @Delete(":id")
  @Permissions("customer.delete")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.clientService.remove(req.user, id);
  }

  @Get(":id/contacts")
  @Permissions("customer.read")
  findContacts(@Req() req: any, @Param("id") id: string) {
    return this.clientService.findContacts(req.user, id);
  }

  @Post(":id/contacts/link")
  @Permissions("customer.update")
  linkContact(
    @Req() req: any,
    @Param("id") id: string,
    @Body() payload: LinkClientContactDto,
  ) {
    return this.clientService.linkContact(req.user, id, payload);
  }

  @Patch(":id/contacts/:customerId/primary")
  @Permissions("customer.update")
  setPrimaryContact(
    @Req() req: any,
    @Param("id") id: string,
    @Param("customerId") customerId: string,
  ) {
    return this.clientService.setPrimaryContact(req.user, id, customerId);
  }

  @Delete(":id/contacts/:customerId")
  @Permissions("customer.update", "orders.confirm-incoming")
  unlinkContact(
    @Req() req: any,
    @Param("id") id: string,
    @Param("customerId") customerId: string,
  ) {
    return this.clientService.unlinkContact(req.user, id, customerId);
  }

  @Get(":id/addresses")
  @Permissions("customer.read", "orders.confirm-incoming")
  findAllAddresses(@Req() req: any, @Param("id") id: string) {
    return this.clientService.findAllAddresses(req.user, id);
  }

  @Post(":id/addresses")
  @Permissions("customer.update")
  createAddress(
    @Req() req: any,
    @Param("id") id: string,
    @Body() payload: CreateClientAddressDto,
  ) {
    return this.clientService.createAddress(req.user, id, payload);
  }

  @Patch(":id/addresses/:addressId")
  @Permissions("customer.update")
  updateAddress(
    @Req() req: any,
    @Param("id") id: string,
    @Param("addressId") addressId: string,
    @Body() payload: UpdateClientAddressDto,
  ) {
    return this.clientService.updateAddress(req.user, id, addressId, payload);
  }

  @Patch(":id/addresses/:addressId/default")
  @Permissions("customer.update")
  setDefaultAddress(
    @Req() req: any,
    @Param("id") id: string,
    @Param("addressId") addressId: string,
  ) {
    return this.clientService.setDefaultAddress(req.user, id, addressId);
  }

  @Delete(":id/addresses/:addressId")
  @Permissions("customer.update")
  removeAddress(
    @Req() req: any,
    @Param("id") id: string,
    @Param("addressId") addressId: string,
  ) {
    return this.clientService.removeAddress(req.user, id, addressId);
  }
}
