import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { OrderActionResult, OrderActionType, OrderEntity, OrderStatus, ReturnRequestEntity } from "entities/order.entity";
import { DataSource, EntityManager, Repository } from "typeorm";
import { OrdersService, tenantId } from "./orders.service";
import { CreateReturnDto } from "dto/order.dto";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { RequestTranslationService, TranslationService } from "common/translation.service";

@Injectable()
export class OrderReturnService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(ReturnRequestEntity)
        private readonly returnRepo: Repository<ReturnRequestEntity>,
        @InjectRepository(OrderEntity)
        private readonly orderRepo: Repository<OrderEntity>,
        private readonly ordersService: OrdersService, // Inject the main service
        private readonly notificationService: NotificationService,
        private readonly translations: TranslationService,
        private requestTranslations: RequestTranslationService,
    ) { }


    async createReturnRequest(dto: CreateReturnDto, me: any) {
        const adminId = tenantId(me);
        const userId = me.id;

        return await this.dataSource.transaction(async (manager) => {

            // Use transaction-scoped repositories
            const returnRepo = manager.getRepository(ReturnRequestEntity);
            const orderRepo = manager.getRepository(OrderEntity);

            // 1. Fetch order with its items
            const order = await orderRepo.findOne({
                where: { id: dto.orderId, adminId },
                relations: ['items']
            });

            if (!order) {
            throw new NotFoundException(this.translations.t('domains.orders.return.order_not_found', { args: { orderId: dto.orderId } }));
        }

            const orderItemsMap = new Map(order.items.map(item => [item.id, item]));

            // 2. Validate requested items
            for (const returnItem of dto.items) {
            const originalOrderItem = orderItemsMap.get(returnItem.originalItemId);
            let errorDetail;
            let errorDetail2;

            if (!originalOrderItem) {
                errorDetail = await this.requestTranslations.tAsync('domains.orders.return.item_not_found', adminId, { args: { itemId: returnItem.originalItemId, orderId: dto.orderId } });
            } else if (returnItem.quantity > originalOrderItem.quantity) {
                errorDetail = await this.requestTranslations.tAsync('domains.orders.return.qty_mismatch', adminId, { args: { requested: returnItem.quantity, purchased: originalOrderItem.quantity } });
            }
            if (!originalOrderItem) {
                errorDetail2 = this.translations.t('domains.orders.return.item_not_found', { args: { itemId: returnItem.originalItemId, orderId: dto.orderId } });
            } else if (returnItem.quantity > originalOrderItem.quantity) {
                errorDetail2 = this.translations.t('domains.orders.return.qty_mismatch', { args: { requested: returnItem.quantity, purchased: originalOrderItem.quantity } });
            }

            if (errorDetail) {
                await this.ordersService.logOrderAction({
                    manager,
                    adminId,
                    userId,
                    orderId: dto.orderId,
                    actionType: OrderActionType.RETURN,
                    result: OrderActionResult.FAILED,
                    details: errorDetail
                });
                throw new BadRequestException(errorDetail2);
            }
        }

            const cleanReason = dto.reason?.trim();

            // 4. Create the return request record
            const returnRequest = returnRepo.create({
                adminId,
                orderId: dto.orderId,
                userId,
                reason: cleanReason,
                items: dto.items.map(item => {
                    const originalItem = orderItemsMap.get(item.originalItemId);
                    return {
                        originalOrderItemId: item.originalItemId,
                        returnedVariantId: originalItem?.variantId,
                        quantity: item.quantity,
                        condition: item.condition?.trim()
                    };
                })
            });

            const savedRequest = await returnRepo.save(returnRequest);

            const preparingStatus = await this.ordersService.findStatusByCode(
                OrderStatus.RETURN_PREPARING,
                adminId,
                manager
            );

            if (preparingStatus) {
                const oldStatusId = order.statusId;

                await orderRepo.update(order.id, {
                    statusId: preparingStatus.id,
                    lastReturnId: savedRequest.id,
                    updatedByUserId: userId
                });

                await this.ordersService.logStatusChange({
                    adminId,
                    orderId: order.id,
                    fromStatusId: oldStatusId,
                    toStatusId: preparingStatus.id,
                    userId,
                    notes: await this.requestTranslations.tAsync('domains.orders.return.moved_to_return_preparing', adminId, {}),
                    manager
                });
            }

            // 5. Log Success
            await this.ordersService.logOrderAction({
                manager,
                adminId,
                userId,
                orderId: dto.orderId,
                actionType: OrderActionType.RETURN,
                result: OrderActionResult.SUCCESS,
                details: await this.requestTranslations.tAsync('domains.orders.return.return_request_created_log', adminId, { args: { orderNumberOrId: order.orderNumber || dto.orderId, itemsCount: dto.items.length } })
            });

            await this.notificationService.create({
                userId: adminId,
                type: NotificationType.RETURN_REQUEST_CREATED,
                title: await this.requestTranslations.tAsync('domains.orders.return.return_request_created_title', adminId),
                message: await this.requestTranslations.tAsync('domains.orders.return.return_request_created_message', adminId, { fromSettings: true, args: { orderNumber: order.orderNumber } }),
                relatedEntityType: "order",
                relatedEntityId: String(order.id),
            });

            return savedRequest;
        });
    }
}