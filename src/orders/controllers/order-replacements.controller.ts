import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { PermissionsGuard } from "common/permissions.guard";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { OrderReplacementService } from "../services/order-replacements.service";
import { Permissions } from "common/permissions.decorator";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { CreateReplacementDto } from "dto/order.dto";
import { Response } from "express";



const replacementsStorage = diskStorage({
    destination: "./uploads/replacement",
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, `product-${uniqueSuffix}${extname(file.originalname)}`);
    },
});

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("order-replacements")
export class OrderReplacemetsController {
    constructor(private svc: OrderReplacementService) { }

    @Permissions("orders.readReplace")
    @Get("list")
    listReplacements(@Req() req: any, @Query() q: any) {
        return this.svc.listReplacements(req.user, q);
    }

    // ✅ Export orders to Excel
    @Permissions("orders.read")
    @Get("export")
    async exportReplacements(@Req() req: any, @Query() q: any, @Res() res: Response) {
        const buffer = await this.svc.exportReplacements(req.user, q);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=Replacement_orders_export_${Date.now()}.xlsx`);

        return res.send(buffer);
    }

    @Permissions('orders.replace')
    @UseInterceptors(
        FileFieldsInterceptor(
            [
                { name: "images", maxCount: 20 },
            ],
            { storage: replacementsStorage }
        )
    )
    @Post('replace')
    async replace(@Req() req: any, @UploadedFiles()
    files: {
        images?: Express.Multer.File[];
    }, @Body() dto: CreateReplacementDto) {
        const imgs = files?.images ?? [];


        if (imgs.length) {
            const uploaded = imgs.map((f) => `/uploads/replacement/${f.filename}`);
            dto.returnImages = [...(dto.returnImages ?? []), ...uploaded];
        } else {
            throw new BadRequestException("At least one image is required");
        }

        return this.svc.replaceOrder(req.user, dto, req.ip);
    }



}