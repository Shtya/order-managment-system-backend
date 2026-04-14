// purchases-return/purchases-return.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { PurchaseReturnsService } from "./purchases-return.service";
import { CreatePurchaseReturnDto, UpdatePurchaseReturnDto, UpdatePurchaseReturnStatusDto, UpdatePaidAmountDto } from "dto/purchase_return.dto";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path/win32";
import { parseJsonField, parseNumber } from "common/healpers";

const purchasesStorage = diskStorage({
  destination: "./uploads/purchases-returns",
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `purchase-returns-${uniqueSuffix}${extname(file.originalname)}`);
  },
});


@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("purchases-return")
@RequireSubscription()
export class PurchaseReturnsController {
  constructor(private svc: PurchaseReturnsService) { }

  @Permissions("purchase_returns.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.svc.stats(req.user);
  }

  @Permissions("purchase_returns.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  // ✅ NEW: Audit logs for invoice
  @Permissions("purchase_returns.read")
  @Get(":id/audit-logs")
  auditLogs(@Req() req: any, @Param("id") id: string) {
    return this.svc.getAuditLogs(req.user, id);
  }

  // ✅ NEW: Accept preview (what will happen on accept)
  @Permissions("purchase_returns.read")
  @Get(":id/accept-preview")
  acceptPreview(@Req() req: any, @Param("id") id: string) {
    return this.svc.acceptPreview(req.user, id);
  }

  @Permissions("purchase_returns.update")
  @Patch(":id/paid-amount")
  updatePaidAmount(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePaidAmountDto) {
    return this.svc.updatePaidAmount(req.user, id, dto, req.ip);
  }


  @Permissions("purchase_returns.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.svc.get(req.user, id);
  }

  @Permissions("purchase_returns.create")
  @UseInterceptors(
    FileFieldsInterceptor([{ name: "receiptAsset", maxCount: 1 }], {
      storage: purchasesStorage,
    })
  )
  @Post()
  async create(
    @Req() req: any,
    @UploadedFiles()
    files: { receiptAsset?: Express.Multer.File[] },
    @Body() body: any
  ) {
    //
    const dto: CreatePurchaseReturnDto = {
      returnNumber: body.returnNumber,
      supplierId: body.supplierId ? body.supplierId : undefined,
      supplierNameSnapshot: body.supplierNameSnapshot,
      supplierCodeSnapshot: body.supplierCodeSnapshot,
      invoiceNumber: body.invoiceNumber,
      returnReason: body.returnReason,
      safeId: body.safeId,
      returnType: body.returnType,
      notes: body.notes ?? undefined,
      paidAmount: body.paidAmount !== undefined ? Number(parseNumber(body.paidAmount)) : undefined,
      items: parseJsonField(body.items, []),
      receiptAsset: body.receiptAsset ?? undefined,
    };


    if (!dto.returnNumber) {
      throw new BadRequestException("returnNumber is required");
    }

    if (!Array.isArray(dto.items) || !dto.items.length) {
      throw new BadRequestException("At least one item is required for return");
    }


    const receiptFile = files?.receiptAsset?.[0];
    if (receiptFile) {
      dto.receiptAsset = `/uploads/purchases-returns/${receiptFile.filename}`;
    }


    return this.svc.create(req.user, dto, req.ip);
  }

  @Permissions("purchase_returns.update")
  @Patch(":id")
  @UseInterceptors(
    FileFieldsInterceptor([{ name: "receiptAsset", maxCount: 1 }], {
      storage: purchasesStorage,
    })
  )
  update(
    @Req() req: any,
    @Param("id") id: string,
    @UploadedFiles()
    files: { receiptAsset?: Express.Multer.File[] },
    @Body() body: any
  ) {
    const dto: UpdatePurchaseReturnDto = {
      supplierId: body.supplierId !== undefined ? body.supplierId : undefined,
      returnNumber: body.returnNumber !== undefined ? body.returnNumber : undefined,
      safeId: body.safeId !== undefined ? body.safeId : undefined,
      paidAmount: body.paidAmount !== undefined ? Number(parseNumber(body.paidAmount)) : undefined,
      notes: body.notes !== undefined ? body.notes : undefined,
      items: body.items !== undefined ? parseJsonField(body.items, []) : undefined,
      receiptAsset: body.receiptAsset !== undefined ? body.receiptAsset : undefined,
      returnReason: body.returnReason !== undefined ? body.returnReason : undefined,
      returnType: body.returnType !== undefined ? body.returnType : undefined,
    } as any;

    const receiptFile = files?.receiptAsset?.[0];
    if (receiptFile) {
      dto.receiptAsset = `/uploads/purchases-returns/${receiptFile.filename}`;
    }

    return this.svc.update(req.user, id, dto, req.ip);
  }

  @Permissions("purchase_returns.update")
  @Patch(":id/status")
  updateStatus(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePurchaseReturnStatusDto) {
    return this.svc.updateStatus(req.user, id, dto.status, req.ip);
  }

  @Permissions("purchase_returns.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.svc.remove(req.user, id, req.ip);
  }


}
