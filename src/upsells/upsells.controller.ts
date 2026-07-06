import {
    Controller, Get, Post, Patch, Delete,
    Param, Query, Req, Res, Body,
    UseGuards,
    BadRequestException,
    UploadedFiles,
    UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { UpsellsService } from './upsells.service';
import { Permissions } from 'common/permissions.decorator';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { CreateUpsellDto, UpdateUpsellDto } from 'dto/upsells.dto';
import { upsellMediaMulterOptions } from './upsell-upload.config';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';

function collectValidationMessages(errors: ValidationError[]): string[] {
    const out: string[] = [];
    for (const e of errors) {
        if (e.constraints) {
            out.push(...Object.values(e.constraints));
        }
        if (e.children?.length) {
            out.push(...collectValidationMessages(e.children));
        }
    }
    return out;
}

async function validateDto<T extends object>(Cls: new () => T, plain: object): Promise<T> {
    const inst = plainToInstance(Cls, plain, { enableImplicitConversion: true });
    const errors = await validate(inst as object, { whitelist: false, forbidUnknownValues: false });
    if (errors.length) {
        throw new BadRequestException(collectValidationMessages(errors));
    }
    return inst;
}

function parseJsonField(raw: unknown): any {
    if (raw == null || raw === '') return undefined;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
        return JSON.parse(String(raw));
    } catch (e) {
        return raw;
    }
}

@Controller('upsells')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UpsellsController {
    constructor(private readonly svc: UpsellsService) { }

    @Get()
    @Permissions('upsells.read')
    async list(@Req() req: any, @Query() q: any) {
        return await this.svc.list(req.user, q);
    }


    @Get('export')
    @Permissions('upsells.read')
    async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
        const buffer = await this.svc.export(req.user, q);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=upsells.xlsx');
        res.send(buffer);
    }

    @Get("history")
    @Permissions('upsells.read')
    async listHistory(@Req() req: any, @Query() q: any) {
        return await this.svc.listHistory(req.user, q);
    }

    @Get('export-history')
    @Permissions('upsells.read')
    async exportHistory(@Req() req: any, @Query() q: any, @Res() res: Response) {
        const buffer = await this.svc.exportHistory(req.user, q);
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=upsell-history-${Date.now()}.xlsx`,
        );
        res.send(buffer);
    }

    @Get('stats')
    @Permissions('upsells.read')
    async stats(@Req() req: any) {
        return await this.svc.stats(req.user);
    }

    @Get(':id')
    @Permissions('upsells.read')
    async getOne(@Req() req: any, @Param('id') id: string) {
        return await this.svc.findOne(req.user, id);
    }

    @Post('upload-header-media')
    @Permissions("upsells.create")
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            upsellMediaMulterOptions,
        ),
    )
    async uploadHeaderMedia(
        @UploadedFiles()
        files: { headerMedia?: Express.Multer.File[] },
    ) {
        const f = files?.headerMedia?.[0];
        if (!f) {
            throw new BadRequestException('headerMedia file is required');
        }
        return { headerUrl: `uploads/upsells/${f.filename}` };
    }

    @Post()
    @Permissions('upsells.create')
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            upsellMediaMulterOptions,
        ),
    )
    async create(
        @Req() req: any,
        @UploadedFiles()
        files: { headerMedia?: Express.Multer.File[] },
    ) {
        const b = req.body || {};
        const messageConfig = parseJsonField(b.messageConfig) || {};

        // Handle file upload
        if (files?.headerMedia?.[0]) {
            const rel = `uploads/upsells/${files.headerMedia[0].filename}`;
            messageConfig.headerUrl = rel;
        }
        // Handle URL or relative path
        else if (b.headerUrl) {
            const headerUrl = String(b.headerUrl).trim();
            if (headerUrl.startsWith('http://') || headerUrl.startsWith('https://')) {
                try {
                    const response = await axios({ method: 'get', url: headerUrl, responseType: 'arraybuffer' });
                    const contentType = response.headers['content-type'] || '';
                    const type = typeof contentType === "string" ? contentType : "";

                    const ext = type.includes("image")
                        ? ".jpg"
                        : type.includes("video")
                            ? ".mp4"
                            : ".pdf";
                    const filename = `upsell_${Date.now()}${ext}`;
                    const filePath = path.join(process.cwd(), 'uploads', 'upsells', filename);

                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                    fs.writeFileSync(filePath, response.data);
                    messageConfig.headerUrl = `uploads/upsells/${filename}`;
                } catch (error) {
                    console.error('Error downloading header media:', error);
                    throw new BadRequestException('Failed to download header media from URL');
                }
            } else if (headerUrl.startsWith('uploads/') || headerUrl.startsWith('/uploads/')) {
                messageConfig.headerUrl = headerUrl.startsWith('/') ? headerUrl.slice(1) : headerUrl;
            }
        }

        const dto = await validateDto(CreateUpsellDto, {
            ...b,
            messageConfig,
        });

        return await this.svc.create(req.user, dto);
    }

    @Patch(':id')
    @Permissions('upsells.update')
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            upsellMediaMulterOptions,
        ),
    )
    async update(
        @Req() req: any,
        @Param('id') id: string,
        @UploadedFiles()
        files: { headerMedia?: Express.Multer.File[] },
    ) {
        const b = req.body || {};
        const messageConfig = parseJsonField(b.messageConfig);

        if (messageConfig) {
            if (files?.headerMedia?.[0]) {
                const rel = `uploads/upsells/${files.headerMedia[0].filename}`;
                messageConfig.headerUrl = rel;
            }
        }

        const dto = await validateDto(UpdateUpsellDto, {
            ...b,
            messageConfig,
        });

        return await this.svc.update(req.user, id, dto);
    }

    @Patch(':id/toggle-active')
    @Permissions('upsells.update')
    async toggleActive(@Req() req: any, @Param('id') id: string) {
        return await this.svc.toggleActive(req.user, id);
    }

    @Delete(':id')
    @Permissions('upsells.delete')
    async remove(@Req() req: any, @Param('id') id: string) {
        return await this.svc.remove(req.user, id);
    }
}
