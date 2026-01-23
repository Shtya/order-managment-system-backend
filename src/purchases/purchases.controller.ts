// purchases/purchases.controller.ts
import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Req,
	UploadedFiles,
	UseGuards,
	UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { PurchasesService } from "./purchases.service";
import {
	CreatePurchaseDto,
	UpdatePurchaseDto,
	UpdatePurchaseStatusDto,
	UpdatePaidAmountDto,
} from "dto/purchase.dto";

import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";

const purchasesStorage = diskStorage({
	destination: "./uploads/purchases",
	filename: (req, file, cb) => {
		const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
		cb(null, `purchase-${uniqueSuffix}${extname(file.originalname)}`);
	},
});

function parseJsonField<T>(val: any, fallback: T): T {
	if (val === undefined || val === null || val === "") return fallback;
	if (typeof val !== "string") return val as T;
	try {
		return JSON.parse(val) as T;
	} catch {
		return fallback;
	}
}

function parseNumber(val: any): number | null | undefined {
	if (val === undefined) return undefined;
	if (val === null || val === "") return null;
	const n = Number(val);
	return Number.isFinite(n) ? n : null;
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("purchases")
export class PurchasesController {
	constructor(private svc: PurchasesService) { }

	@Permissions("purchases.read")
	@Get("stats")
	stats(@Req() req: any) {
		return this.svc.stats(req.user);
	}

	@Permissions("purchases.read")
	@Get()
	list(@Req() req: any, @Query() q: any) {
		return this.svc.list(req.user, q);
	}

	@Permissions("purchases.read")
	@Get(":id")
	get(@Req() req: any, @Param("id") id: string) {
		return this.svc.get(req.user, Number(id));
	}

	// ✅ NEW: Audit logs for invoice
	@Permissions("purchases.read")
	@Get(":id/audit-logs")
	auditLogs(@Req() req: any, @Param("id") id: string) {
		return this.svc.getAuditLogs(req.user, Number(id));
	}

	// ✅ NEW: Accept preview (what will happen on accept)
	@Permissions("purchases.read")
	@Get(":id/accept-preview")
	acceptPreview(@Req() req: any, @Param("id") id: string) {
		return this.svc.acceptPreview(req.user, Number(id));
	}

	@Permissions("purchases.create")
	@Post()
	@UseInterceptors(
		FileFieldsInterceptor([{ name: "receiptAsset", maxCount: 1 }], {
			storage: purchasesStorage,
		})
	)
	create(
		@Req() req: any,
		@UploadedFiles()
		files: { receiptAsset?: Express.Multer.File[] },
		@Body() body: any
	) {
		const dto: CreatePurchaseDto = {
			supplierId: Number(parseNumber(body.supplierId)),
			receiptNumber: body.receiptNumber,
			safeId: body.safeId,
			paidAmount:
				body.paidAmount !== undefined ? Number(parseNumber(body.paidAmount)) : undefined,
			notes: body.notes ?? undefined,
			items: parseJsonField(body.items, []),
			receiptAsset: body.receiptAsset ?? undefined,
		} as any;

		if (!dto.receiptNumber) throw new BadRequestException("receiptNumber is required");
		if (!Array.isArray(dto.items) || !dto.items.length)
			throw new BadRequestException("Items are required");

		const receiptFile = files?.receiptAsset?.[0];
		if (receiptFile) {
			dto.receiptAsset = `/uploads/purchases/${receiptFile.filename}`;
		}

		return this.svc.create(req.user, dto, req.ip);
	}

	@Permissions("purchases.update")
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
		const dto: UpdatePurchaseDto = {
			supplierId:
				body.supplierId !== undefined ? Number(parseNumber(body.supplierId)) : undefined,
			receiptNumber: body.receiptNumber !== undefined ? body.receiptNumber : undefined,
			safeId: body.safeId !== undefined ? Number(parseNumber(body.safeId)) : undefined,
			paidAmount:
				body.paidAmount !== undefined ? Number(parseNumber(body.paidAmount)) : undefined,
			notes: body.notes !== undefined ? body.notes : undefined,
			items: body.items !== undefined ? parseJsonField(body.items, []) : undefined,
			receiptAsset: body.receiptAsset !== undefined ? body.receiptAsset : undefined,
		} as any;

		const receiptFile = files?.receiptAsset?.[0];
		if (receiptFile) {
			dto.receiptAsset = `/uploads/purchases/${receiptFile.filename}`;
		}

		return this.svc.update(req.user, Number(id), dto, req.ip);
	}

	@Permissions("purchases.update")
	@Patch(":id/status")
	updateStatus(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePurchaseStatusDto) {
		return this.svc.updateStatus(req.user, Number(id), dto.status, req.ip);
	}

	@Permissions("purchases.update")
	@Patch(":id/paid-amount")
	updatePaidAmount(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePaidAmountDto) {
		return this.svc.updatePaidAmount(req.user, Number(id), dto, req.ip);
	}

	@Permissions("purchases.delete")
	@Delete(":id")
	remove(@Req() req: any, @Param("id") id: string) {
		return this.svc.remove(req.user, Number(id), req.ip);
	}
}
