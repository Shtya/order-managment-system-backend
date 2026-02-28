import { Body, Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import { CollectionService } from "./collection.service";
import { CreateOrderCollectionDto } from "dto/order-collection.dto";
import { Permissions } from "common/permissions.decorator";
import { Response } from "express";


@Controller('collections')
export class CollectionController {
    constructor(private readonly collectionService: CollectionService) { }


    @Permissions("orders-collect.create")
    @Post()
    async create(
        @Req() req,
        @Body() createDto: CreateOrderCollectionDto
    ) {
        // req.user.adminId should be populated by your AuthGuard
        return this.collectionService.addCollection(req.user.adminId, createDto);
    }

    @Permissions("orders-collect.read")
    @Get('statistics')
    async getStats(@Req() req) {
        // [2025-12-24] Ensure statistics are trimmed to the active admin session
        return this.collectionService.getCollectionStatistics(req.user.adminId);
    }


    @Permissions("orders-collect.read")
    @Get()
    list(@Req() req: any, @Query() q: any) {
        return this.collectionService.listCollections(req.user, q);
    }

    @Permissions("orders-collect.read")
    @Get("export")
    async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
        const buffer = await this.collectionService.exportCollections(req.user, q);

        const filename = `collections_report_${new Date().toISOString().split('T')[0]}.xlsx`;

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

        return res.send(buffer);
    }
}