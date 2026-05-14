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

        if (files?.headerMedia?.[0]) {
            const rel = `uploads/whatsapp-templates/${files.headerMedia[0].filename}`;
            templateConfig = { ...templateConfig, headerUrl: rel };
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

    
    @Patch(':id')
    @Permissions("whatsapp.templates.update")
    async update(
        @Req() req: any,
        @Param('id') id: string,
        @Body() data: UpdateWhatsappTemplateDto,
    ) {
        return await this.svc.update(req.user, id, data);
    }

    @Delete(':id')
    @Permissions("whatsapp.templates.delete")
    async delete(@Req() req: any, @Param('id') id: string) {
        return await this.svc.delete(req.user, id);
    }
}
