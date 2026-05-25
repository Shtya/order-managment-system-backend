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
import { WhatsappTemplateService } from '../services/WhatsappTemplate.service';
import { Permissions } from 'common/permissions.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { CreateWhatsappTemplateDto, UpdateWhatsappTemplateDto } from 'dto/whatsapp.dto';
import { whatsappTemplateHeaderMulterOptions } from './whatsapp-template-upload.config';
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

function parseTemplateConfig(raw: unknown): Record<string, unknown> {
    if (raw == null || raw === '') {
        return {};
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            throw new BadRequestException('Invalid templateConfig JSON');
        }
    }
    throw new BadRequestException('Invalid templateConfig');
}

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('whatsapp-templates')
export class WhatsappTemplateController {
    constructor(private readonly svc: WhatsappTemplateService) { }

    @Get()
    @Permissions("whatsapp.read")
    async getAll(@Req() req: any, @Query() q: any) {
        return await this.svc.list(req.user, q);
    }

    @Get("/library")
    @Permissions("whatsapp.read")
    async getAllLibrary(@Req() req: any, @Query() q: any) {
        return await this.svc.list(req.user, q, true);
    }

    @Get('export')
    @Permissions("whatsapp.read")
    async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
        const buffer = await this.svc.export(req.user, q);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=templates_export_${Date.now()}.xlsx`);
        return res.send(buffer);
    }

    /** Upload header media (IMAGE / VIDEO / DOCUMENT) before create or when updating template config */
    @Post('upload-header-media')
    @Permissions("whatsapp.read")
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            whatsappTemplateHeaderMulterOptions,
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
        return { headerUrl: `uploads/whatsapp-templates/${f.filename}` };
    }

    @Get('meta-library')
    @Permissions('whatsapp.read')
    async metaLibrary(@Req() req: any, @Query() q: any) {
        return await this.svc.metaLibrary(req.user, q);
    }

    @Get(':id')
    @Permissions("whatsapp.read")
    async getOne(@Req() req: any, @Param('id') id: string) {
        return await this.svc.findOne(req.user, id);
    }


    @Post()
    @Permissions("whatsapp.templates.create")
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            whatsappTemplateHeaderMulterOptions,
        ),
    )
    async create(
        @Req() req: any,
        @UploadedFiles()
        files: { headerMedia?: Express.Multer.File[] },
    ) {
        const b = req.body || {};
        let templateConfig = parseTemplateConfig(b.templateConfig);

        // Handle file upload
        if (files?.headerMedia?.[0]) {
            const rel = `uploads/whatsapp-templates/${files.headerMedia[0].filename}`;
            templateConfig = { ...templateConfig, headerUrl: rel };
        }

        // Handle URL or relative path
        else if (b.headerUrl) {
            const headerUrl = String(b.headerUrl).trim();
            // If it's a full URL, download and save locally
            if (headerUrl.startsWith('http://') || headerUrl.startsWith('https://')) {
                try {
                    const response = await axios({ method: 'get', url: headerUrl, responseType: 'arraybuffer' });
                    const ext = this.getFileExtension(response.headers['content-type'] || headerUrl);
                    const filename = `${Date.now()}_header${ext}`;
                    const filePath = path.join(process.cwd(), 'uploads', 'whatsapp-templates', filename);

                    // Ensure directory exists
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    fs.writeFileSync(filePath, response.data);
                    const rel = `uploads/whatsapp-templates/${filename}`;
                    templateConfig = { ...templateConfig, headerUrl: rel };
                } catch (error) {
                    console.error('Error downloading header media:', error);
                    throw new BadRequestException('Failed to download header media from URL');
                }
            }
            // If it's already a relative path (uploads/... or /uploads/...), use as is
            else if (headerUrl.startsWith('uploads/') || headerUrl.startsWith('/uploads/')) {
                templateConfig = { ...templateConfig, headerUrl: headerUrl.startsWith('/') ? headerUrl.slice(1) : headerUrl };
            }
        }

        const dto = await validateDto(CreateWhatsappTemplateDto, {
            accountId: b.accountId,
            name: b.name,
            category: b.category,
            subCategory: b.subCategory,
            language: b.language,
            templateConfig,
        });

        return await this.svc.create(req.user, dto);
    }

    private getFileExtension(contentType: string, url: string = ''): string {
        const mimeTypes: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'video/mp4': '.mp4',
            'video/quicktime': '.mov',
            'application/pdf': '.pdf',
        };

        if (mimeTypes[contentType]) {
            return mimeTypes[contentType];
        }

        // Try to extract from URL
        const urlMatch = url.match(/\.(jpg|jpeg|png|gif|mp4|mov|pdf)$/i);
        if (urlMatch) {
            return urlMatch[0];
        }

        return '.jpg'; // Default
    }


    @Patch(':id')
    @Permissions("whatsapp.templates.update")
    // 1. أضفنا الـ Interceptor لقراءة الـ FormData والملفات المرفوعة أثناء التعديل
    @UseInterceptors(
        FileFieldsInterceptor(
            [{ name: 'headerMedia', maxCount: 1 }],
            whatsappTemplateHeaderMulterOptions,
        ),
    )
    async update(
        @Req() req: any,
        @Param('id') id: string,
        @UploadedFiles()
        files: { headerMedia?: Express.Multer.File[] },
    ) {
        const b = req.body || {};


        let templateConfig = undefined;
        if (b.templateConfig) {
            templateConfig = parseTemplateConfig(b.templateConfig);
        }


        if (files?.headerMedia?.[0]) {
            const rel = `uploads/whatsapp-templates/${files.headerMedia[0].filename}`;
            templateConfig = { ...(templateConfig || {}), headerUrl: rel };
        }


        const dto = await validateDto(UpdateWhatsappTemplateDto, {
            name: b.name || undefined,
            category: b.category || undefined,
            subCategory: b.subCategory || undefined,
            language: b.language || undefined,
            ...(templateConfig && { templateConfig }),
        });

        return await this.svc.update(req.user, id, dto);
    }

    @Delete(':id')
    @Permissions("whatsapp.templates.delete")
    async delete(@Req() req: any, @Param('id') id: string) {
        return await this.svc.delete(req.user, id);
    }
}
