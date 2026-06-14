import { Injectable, BadRequestException, NotFoundException, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, Not, In } from 'typeorm';
import { Upsell, UpsellHistory, UpsellStatus } from 'entities/upsells.entity';
import { ProductEntity, ProductVariantEntity } from 'entities/sku.entity';
import { CreateUpsellDto, UpdateUpsellDto } from 'dto/upsells.dto';

import { WhatsappApiService } from '../whatsapp/services/WhatsappApi.service';
import * as ExcelJS from 'exceljs';
import { tenantId } from 'src/category/category.service';
import { calculateRange } from 'common/healpers';
import { DateFilterUtil } from 'common/date-filter.util';
import { OrdersService } from '../orders/services/orders.service';
import { OrderEntity, OrderStatus } from 'entities/order.entity';
import { AutomationRunEntity } from 'entities/automation.entity';
import { WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';

@Injectable()
export class UpsellsService {
    constructor(
        @InjectRepository(Upsell)
        private readonly upsellRepo: Repository<Upsell>,
        @InjectRepository(UpsellHistory)
        private readonly upsellHistoryRepo: Repository<UpsellHistory>,
        @InjectRepository(ProductEntity)
        private readonly productRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity)
        private readonly skuRepo: Repository<ProductVariantEntity>,
        @InjectRepository(WhatsappAccountEntity)
        private readonly accountRepo: Repository<WhatsappAccountEntity>,
        @Inject(forwardRef(() => WhatsappApiService))
        private readonly whatsappApi: WhatsappApiService,
        @Inject(forwardRef(() => WhatsappService))
        private readonly whatsappService: WhatsappService,
        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
        private readonly notificationService: NotificationService,
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
        // const upsellingProducts = triggerProduct.upsellingProducts || [];
        // const isLinked = upsellingProducts.some(p => p.productId === dto.upsellProductId);
        // if (!isLinked) {
        //     throw new BadRequestException('The selected upsell product is not linked to the trigger product');
        // }

        if (sku.productId !== dto.upsellProductId) {
            throw new BadRequestException('SKU does not belong to the upsell product');
        }

        // 2.5 Check for uniqueness (triggerProductId, upsellProductId, upsellSkuId, adminId, upsellPrice)
        const existing = await this.upsellRepo.findOne({
            where: {
                triggerProductId: dto.triggerProductId,
                upsellProductId: dto.upsellProductId,
                upsellSkuId: dto.upsellSkuId,
                upsellPrice: dto.upsellPrice,
                adminId
            }
        });
        if (existing) {
            throw new BadRequestException(`An upsell already exists for the same trigger product, upsell product, SKU, and price (${dto.upsellPrice})`);
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

        // Validation logic similar to create if IDs or Price change
        if (dto.triggerProductId || dto.upsellProductId || dto.upsellSkuId || dto.upsellPrice !== undefined) {
            const triggerId = dto.triggerProductId || upsell.triggerProductId;
            const upsellId = dto.upsellProductId || upsell.upsellProductId;
            const skuId = dto.upsellSkuId || upsell.upsellSkuId;
            const price = dto.upsellPrice !== undefined ? dto.upsellPrice : upsell.upsellPrice;

            const triggerProduct = await this.productRepo.findOne({ where: { id: triggerId } });
            if (!triggerProduct) throw new BadRequestException('Trigger product not found');

            const upsellProduct = await this.productRepo.findOne({ where: { id: upsellId } });
            if (!upsellProduct) throw new BadRequestException('Upsell product not found');

            const sku = await this.skuRepo.findOne({ where: { id: skuId, productId: upsellId } });
            if (!sku) throw new BadRequestException('SKU not found or does not belong to the upsell product');

            upsell.triggerProduct = triggerProduct;
            upsell.triggerProductId = triggerProduct.id;

            upsell.upsellProduct = upsellProduct;
            upsell.upsellProductId = upsellProduct.id;
            upsell.upsellSku = sku;
            upsell.upsellSkuId = sku.id;


            // const upsellingProducts = triggerProduct.upsellingProducts || [];
            // const isLinked = upsellingProducts.some(p => p.productId === upsellId);
            // if (!isLinked) {
            //     throw new BadRequestException('The selected upsell product is not linked to the trigger product');
            // }

            // Check for uniqueness if IDs or Price changed
            const existing = await this.upsellRepo.findOne({
                where: {
                    triggerProductId: triggerId,
                    upsellProductId: upsellId,
                    upsellSkuId: skuId,
                    upsellPrice: price,
                    adminId,
                    id: Not(id)
                }
            });
            if (existing) {
                throw new BadRequestException(`An upsell already exists for the same trigger product, upsell product, SKU, and price (${price})`);
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

        if (dto.expireTimeM !== undefined) {
            upsell.expireTimeM = dto.expireTimeM;
        }

        if (dto.isActive !== undefined) {
            upsell.isActive = dto.isActive;
        }

        if (dto.upsellPrice !== undefined) {
            upsell.upsellPrice = dto.upsellPrice;
        }


        upsell.messageConfig = messageConfig;

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

    async stats(me: any, filters: any = {}) {
        const adminId = tenantId(me);

        const qb = this.upsellHistoryRepo
            .createQueryBuilder('uh')
            .leftJoin('orders', 'o', 'o.id = uh.orderId')
            .leftJoin('order_statuses', 'os', 'os.id = o.statusId')
            .select('uh.status', 'status')
            .addSelect('os.code', 'orderStatusCode')
            .addSelect('COUNT(*)', 'count')
            .where('uh."adminId" = :adminId', { adminId });

        if (filters.startDate) {
            qb.andWhere('uh."createdAt" >= :startDate', { startDate: new Date(filters.startDate) });
        }
        if (filters.endDate) {
            qb.andWhere('uh."createdAt" <= :endDate', { endDate: new Date(filters.endDate) });
        }
        if (filters.range) {
            const { start, end } = calculateRange(filters.range);
            if (start) qb.andWhere('uh."createdAt" >= :start', { start });
            if (end) qb.andWhere('uh."createdAt" <= :end', { end });
        }

        const stats = await qb
            .groupBy('uh.status')
            .addGroupBy('os.code')
            .getRawMany();

        const result = {
            sent: 0,
            accepted: 0,
            rejected: 0,
            noAnswer: 0,
            expired: 0,
            acceptedNonEligible: 0,
            failedToAdd: 0,
            delivered: 0,
            pending: 0,
        };

        stats.forEach(s => {
            const count = parseInt(s.count, 10);
            const status = s.status;
            const orderStatusCode = s.orderStatusCode;

            // Total Sent (All records contribute to total sent)
            result.sent += count;

            if (status === UpsellStatus.ACCEPTED) {
                if (orderStatusCode === OrderStatus.DELIVERED) {
                    result.delivered += count;
                } else {
                    result.accepted += count;
                }
            }
            else if (status === UpsellStatus.REJECTED) {
                result.rejected += count;
            }
            else if (status === UpsellStatus.EXPIRED) {
                result.expired += count;
            }
            else if (status === UpsellStatus.PENDING) {
                result.pending += count;
            }

            else if (status === UpsellStatus.ACCEPTED_NON_ELIGIBLE) {
                result.acceptedNonEligible += count;
            }
            else if (status === UpsellStatus.FAILED_TO_ADD) {
                result.failedToAdd += count;
            }
        });

        return result;
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

    async getUpsellsByProductIds(productIds: string[], adminId: string): Promise<Upsell[]> {
        return await this.upsellRepo.find({
            where: {
                triggerProductId: In(productIds),
                adminId: adminId,
                isActive: true,
            },
            relations: ['triggerProduct', 'upsellProduct', 'upsellSku'],
        });
    }

    async sendUpsell(upsell: Upsell, order: OrderEntity, run?: AutomationRunEntity) {
        const adminId = order.adminId;

    
        const config = upsell.messageConfig;
        if (!config) return null;

        const interactive: any = {
            type: 'button',
            body: { text: config.bodyText },
        };

        if (config.headerType !== 'NONE') {
            if (config.headerType === 'TEXT') {
                interactive.header = { type: 'text', text: config.headerText };
            } else {
                const media = await this.whatsappService.uploadMedia({ id: adminId, adminId }, { url: config.headerUrl });
                interactive.header = {
                    type: config.headerType.toLowerCase(),
                    [config.headerType.toLowerCase()]: {
                        id: media?.id,
                        ...(config.headerType === 'DOCUMENT' ? { filename: media?.filename } : {})
                    }
                };
            }
        }

        if (config.footerText) {
            interactive.footer = { text: config.footerText };
        }

        // Add buttons from config
        if (config.buttons && config.buttons.length > 0) {
            interactive.action = {
                buttons: config.buttons.map((btn, idx) => ({
                    type: 'reply',
                    reply: {
                        id: `upsell_${upsell.id}_btn_${idx}`,
                        title: btn.text.slice(0, 20) // Meta limit is 20 chars
                    }
                }))
            };
        }

        const response = await this.whatsappService.sendMessage(
            { id: adminId, adminId },
            {
                to: order.phoneNumber,
                messaging_product: 'whatsapp',
                type: 'interactive',
                interactive,

            },
        );

        // Save Upsell History record
        const expiresAt = upsell.expireTimeM ? new Date(Date.now() + upsell.expireTimeM * 60000) : null;
        const messageId = response.messages[0].id;
        const history = this.upsellHistoryRepo.create({
            adminId,
            upsellId: upsell.id,
            automationRunId: run?.id,
            orderId: order.id,
            messageId,
            status: UpsellStatus.PENDING,
            sentConfig: config,
            triggerProductId: upsell.triggerProductId,
            upsellProductId: upsell.upsellProductId,
            upsellSkuId: upsell.upsellSkuId,
            sentPrice: upsell.upsellPrice,
            expiresAt,
        });

        return await this.upsellHistoryRepo.save(history);
    }

    async applyUpsellByMessageId(me: any, messageId: string) {
        const adminId = tenantId(me);
        const history = await this.upsellHistoryRepo.findOne({
            where: { messageId, adminId },
            order: { createdAt: 'DESC' },
        });
        
        if (!history) {
            return { success: false, code: 'HISTORY_NOT_FOUND', message: 'No upsell history found for this message' };
        }

        const result = await this.applyUpsellToOrder(me, history.orderId, history.upsellId);

        if(result.success || result.code === 'INVALID_ORDER_STATUS' || result.code === 'ORDER_DELIVERED' || result.code === 'UPSELL_EXPIRED') {
            await this.notificationService.create({
                userId: adminId,
                type: NotificationType.UPSELL_UPDATED,
                title: "Upsell Updated",
                message: result.message,
                relatedEntityType: "order",
                relatedEntityId: String(history.orderId),
            });
        }

        return result;
    }

    async applyUpsellToOrder(me: any, orderId: string, upsellId: string) {
        const adminId = tenantId(me);

        // 1. Fetch Order (with status)
        let order: OrderEntity;
        try {
            order = await this.ordersService.get(me, orderId);
        } catch (err) {
            return { success: false, code: 'ORDER_NOT_FOUND', message: "can't apply upsell to order, order not found" };
        }

        if (!order) {
            return { success: false, code: 'ORDER_NOT_FOUND', message: "can't apply upsell to order, order not found" };
        }

        // 2. Fetch Upsell
        const upsell = await this.upsellRepo.findOne({
            where: { id: upsellId, adminId },
            relations: ['upsellSku']
        });
        if (!upsell) {
            return { success: false, code: 'UPSELL_NOT_FOUND', message: `can't apply upsell to order ${order?.orderNumber}, upsell not found` };
        }

        // 3. Check Order Status
        const orderStatusCode = order.status?.code;

        // Handle Ineligibility (Warehouse or Delivered)
        if (orderStatusCode === OrderStatus.DELIVERED || (orderStatusCode && this.ordersService.isWarehouseStatus(orderStatusCode))) {
            const history = await this.upsellHistoryRepo.findOne({
                where: { orderId, upsellId, adminId },
                order: { createdAt: 'DESC' }
            });
            if (history && history.status === UpsellStatus.PENDING) {
                history.status = UpsellStatus.ACCEPTED_NON_ELIGIBLE;
                history.respondedAt = new Date();
                await this.upsellHistoryRepo.save(history);
            }

            if (orderStatusCode === OrderStatus.DELIVERED) {
                return { success: false, code: 'ORDER_DELIVERED', message: `Order ${order?.orderNumber} has been delivered and cannot be edited` };
            }
            return {
                success: false,
                code: 'INVALID_ORDER_STATUS',
                message: `Order ${order?.orderNumber} has already entered the warehouse (Status: '${orderStatusCode}'), cannot add upsells`,
                status: orderStatusCode
            };
        }

        // 4. Check Upsell History & Expiration
        const history = await this.upsellHistoryRepo.findOne({
            where: { orderId, upsellId, adminId },
            order: { createdAt: 'DESC' }
        });

        if (!history) {
            return { success: false, code: 'HISTORY_NOT_FOUND', message: `No upsell history found for order ${order?.orderNumber}` };
        }

        if (history.status === UpsellStatus.ACCEPTED) {
            return { success: false, code: 'ALREADY_ACCEPTED', message: `Upsell for ${upsell?.upsellSku.sku} has already been accepted and applied to order ${order?.orderNumber}` };
        }

        if (history.status === UpsellStatus.EXPIRED || (history.expiresAt && history.expiresAt < new Date())) {
            if (history.status !== UpsellStatus.EXPIRED) {
                history.status = UpsellStatus.EXPIRED;
                await this.upsellHistoryRepo.save(history);
            }
            return { success: false, code: 'UPSELL_EXPIRED', message: `Upsell link for order ${order?.orderNumber} has expired` };
        }

        // 5. Apply to Order
        try {
            // We use the ordersService.update to add the item
            // update() handles existing items, stock reservation, etc.
            await this.ordersService.update(me, orderId, {
                items: [
                    {
                        variantId: upsell.upsellSkuId,
                        quantity: 1,
                        unitPrice: Number(upsell.upsellPrice),
                        isAdditional: true
                    }
                ]
            } as any);

            // 6. Update History
            history.status = UpsellStatus.ACCEPTED;
            history.respondedAt = new Date();
            await this.upsellHistoryRepo.save(history);

            return { success: true, code: 'SUCCESS', message: `Upsell for ${upsell?.upsellSku.sku} has been applied successfully at order ${order?.orderNumber}` };
        } catch (err) {
            console.error('Failed to apply upsell:', err);

            // Update History to FAILED_TO_ADD
            if (history && history.status === UpsellStatus.PENDING) {
                history.status = UpsellStatus.FAILED_TO_ADD;
                history.respondedAt = new Date();
                await this.upsellHistoryRepo.save(history);
            }

            // Send notification to admin
            await this.notificationService.create({
                userId: adminId,
                type: NotificationType.UPSELL_APPLICATION_FAILED,
                title: 'Upsell Application Failed',
                message: `Failed to apply upsell for order ${order.orderNumber}: ${err.message}`,
                relatedEntityType: 'order',
                relatedEntityId: order.id,
            });

            return { success: false, code: 'APPLY_FAILED', message: err.message };
        }
    }

    async export(me: any, q: any) {
        const { records } = await this.list(me, { ...q, limit: 1000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Upsells');

        worksheet.columns = [
            { header: 'Trigger Product', key: 'triggerProduct', width: 25 },
            { header: 'Upsell Product', key: 'upsellProduct', width: 25 },
            { header: 'Upsell SKU', key: 'upsellSku', width: 20 },
            { header: 'Time (minute)', key: 'expireTimeM', width: 20 },
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
                expireTimeM: u.expireTimeM || "-",
                price: u.upsellPrice,
                status: u.isActive ? 'Active' : 'Inactive',
                createdAt: u.createdAt,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }
}
