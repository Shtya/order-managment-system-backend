import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, Not } from 'typeorm';
import { Upsell } from 'entities/upsells.entity';
import { ProductEntity, ProductVariantEntity } from 'entities/sku.entity';
import { CreateUpsellDto, UpdateUpsellDto } from 'dto/upsells.dto';

import { WhatsappApiService } from '../whatsapp/services/WhatsappApi.service';
import * as ExcelJS from 'exceljs';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';

@Injectable()
export class UpsellsService {
    constructor(
        @InjectRepository(Upsell)
        private readonly upsellRepo: Repository<Upsell>,
        @InjectRepository(ProductEntity)
        private readonly productRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity)
        private readonly skuRepo: Repository<ProductVariantEntity>,
        private readonly whatsappApi: WhatsappApiService,
    ) { }

    async create(me: any, dto: CreateUpsellDto) {
        const adminId = tenantId(me);

        // 1. Verify products exist and belong to the same admin (if applicable)
        const triggerProduct = await this.productRepo.findOne({ where: { id: dto.triggerProductId } });
        if (!triggerProduct) throw new BadRequestException('Trigger product not found');

        const upsellProduct = await this.productRepo.findOne({ where: { id: dto.upsellProductId }, relations: ['variants'] });
        if (!upsellProduct) throw new BadRequestException('Upsell product not found');

        const sku = await this.skuRepo.findOne({ where: { id: dto.upsellSkuId, productId: dto.upsellProductId } });
        if (!sku) throw new BadRequestException('SKU not found or does not belong to the upsell product');

        // 2. Check if upsell is linked to trigger (business logic check)
        const upsellingProducts = triggerProduct.upsellingProducts || [];
        const isLinked = upsellingProducts.some(p => p.productId === dto.upsellProductId);
        if (!isLinked) {
            throw new BadRequestException('The selected upsell product is not linked to the trigger product');
        }

        if (sku.productId !== dto.upsellProductId) {
            throw new BadRequestException('SKU does not belong to the upsell product');
        }

        // 2.5 Check for uniqueness (triggerProductId, upsellProductId, upsellSkuId)
        const existing = await this.upsellRepo.findOne({
            where: {
                triggerProductId: dto.triggerProductId,
                upsellProductId: dto.upsellProductId,
                upsellSkuId: dto.upsellSkuId,
                adminId
            }
        });
        if (existing) {
            throw new BadRequestException('An upsell with this trigger product, upsell product, and SKU already exists');
        }

        // 3. Handle media handle if applicable
        const messageConfig = { ...dto.messageConfig };
        if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(messageConfig.headerType) && messageConfig.headerUrl) {
            try {
                messageConfig.headerHandle = await this.whatsappApi.uploadMediaToMeta(messageConfig.headerUrl);
            } catch (err) {
                console.error('Failed to upload media to Meta:', err);
                // We might still want to save, or throw error. Usually better to throw if it's required.
                throw new BadRequestException('Failed to process header media for WhatsApp: ' + err.message);
            }
        }

        const upsell = this.upsellRepo.create({
            ...dto,
            adminId,
            messageConfig,
        });

        return await this.upsellRepo.save(upsell);
    }

    async update(me: any, id: string, dto: UpdateUpsellDto) {
        const adminId = tenantId(me);
        const upsell = await this.findOne(me, id);

        // Validation logic similar to create if IDs change
        if (dto.triggerProductId || dto.upsellProductId || dto.upsellSkuId) {
            const triggerId = dto.triggerProductId || upsell.triggerProductId;
            const upsellId = dto.upsellProductId || upsell.upsellProductId;
            const skuId = dto.upsellSkuId || upsell.upsellSkuId;

            const triggerProduct = await this.productRepo.findOne({ where: { id: triggerId } });
            if (!triggerProduct) throw new BadRequestException('Trigger product not found');

            const upsellProduct = await this.productRepo.findOne({ where: { id: upsellId } });
            if (!upsellProduct) throw new BadRequestException('Upsell product not found');

            const sku = await this.skuRepo.findOne({ where: { id: skuId, productId: upsellId } });
            if (!sku) throw new BadRequestException('SKU not found or does not belong to the upsell product');

            const upsellingProducts = triggerProduct.upsellingProducts || [];
            const isLinked = upsellingProducts.some(p => p.productId === upsellId);
            if (!isLinked) {
                throw new BadRequestException('The selected upsell product is not linked to the trigger product');
            }

            // Check for uniqueness if IDs changed
            const existing = await this.upsellRepo.findOne({
                where: {
                    triggerProductId: triggerId,
                    upsellProductId: upsellId,
                    upsellSkuId: skuId,
                    adminId,
                    id: Not(id)
                }
            });
            if (existing) {
                throw new BadRequestException('An upsell with this trigger product, upsell product, and SKU already exists');
            }
        }

        const messageConfig = dto.messageConfig ? { ...dto.messageConfig } : upsell.messageConfig;

        // If headerUrl changed, re-upload to Meta
        if (dto.messageConfig?.headerUrl && dto.messageConfig.headerUrl !== upsell.messageConfig?.headerUrl) {
            if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(messageConfig.headerType)) {
                try {
                    messageConfig.headerHandle = await this.whatsappApi.uploadMediaToMeta(messageConfig.headerUrl);
                } catch (err) {
                    throw new BadRequestException('Failed to process header media for WhatsApp: ' + err.message);
                }
            }
        }

        Object.assign(upsell, {
            ...dto,
            messageConfig,
        });

        return await this.upsellRepo.save(upsell);
    }

    async list(me: any, q?: any) {
        const adminId = tenantId(me);
        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const status = q?.status;
        const productId = q?.productId;

        const qb = this.upsellRepo.createQueryBuilder('u')
            .leftJoinAndSelect('u.triggerProduct', 'tp')
            .leftJoin("tp.variants", "tpVariant")
            .leftJoinAndSelect('u.upsellProduct', 'up')
            .leftJoin("up.variants", "upVariant")
            .leftJoinAndSelect('u.upsellSku', 'us')
            .where('u.adminId = :adminId', { adminId });

        if (status !== undefined && status !== 'all') {
            qb.andWhere('u.isActive = :isActive', { isActive: status === 'active' });
        }

        if (productId && productId !== 'all') {
            qb.andWhere('u.triggerProductId = :triggerProductId', { triggerProductId: productId })
                .orWhere('u.upsellProductId = :upsellProductId', { upsellProductId: productId });
        }

        DateFilterUtil.applyToQueryBuilder(qb, 'u.createdAt', q?.startDate, q?.endDate);

        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where('tp.name ILIKE :s', { s: `%${search}%` })
                    .orWhere('up.name ILIKE :s', { s: `%${search}%` })
                    .orWhere('us.sku ILIKE :s', { s: `%${search}%` })
                    .orWhere('tpVariant.sku ILIKE :s', { s: `%${search}%` })
                    .orWhere('upVariant.sku ILIKE :s', { s: `%${search}%` })
            }));
        }

        qb.orderBy('u.createdAt', 'DESC');

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return { total_records: total, current_page: page, per_page: limit, records };
    }

    async findOne(me: any, id: string) {
        const adminId = tenantId(me);
        const upsell = await this.upsellRepo.findOne({
            where: { id, adminId },
            relations: ['triggerProduct', 'upsellProduct', 'upsellSku']
        });
        if (!upsell) throw new NotFoundException('Upsell not found');
        return upsell;
    }

    async stats(me) {
        return {
            sent: 0,
            accepted: 0,
            rejected: 0,
            noAnswer: 0,
            acceptedAfterTime: 0
        }
    }


    async remove(me: any, id: string) {
        const upsell = await this.findOne(me, id);
        return await this.upsellRepo.remove(upsell);
    }

    async toggleActive(me: any, id: string) {
        const upsell = await this.findOne(me, id);
        upsell.isActive = !upsell.isActive;
        return await this.upsellRepo.save(upsell);
    }

    async export(me: any, q: any) {
        const { records } = await this.list(me, { ...q, limit: 1000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Upsells');

        worksheet.columns = [
            { header: 'Trigger Product', key: 'triggerProduct', width: 25 },
            { header: 'Upsell Product', key: 'upsellProduct', width: 25 },
            { header: 'Upsell SKU', key: 'upsellSku', width: 20 },
            { header: 'Price', key: 'price', width: 15 },
            { header: 'Status', key: 'status', width: 15 },
            { header: 'Created At', key: 'createdAt', width: 25 },
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' },
        };

        records.forEach(u => {
            worksheet.addRow({
                triggerProduct: u.triggerProduct?.name || 'N/A',
                upsellProduct: u.upsellProduct?.name || 'N/A',
                upsellSku: u.upsellSku?.sku || 'N/A',
                price: u.upsellPrice,
                status: u.isActive ? 'Active' : 'Inactive',
                createdAt: u.createdAt,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }
}
