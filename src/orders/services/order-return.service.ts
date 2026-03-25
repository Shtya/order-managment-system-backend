import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { OrderActionResult, OrderActionType, OrderEntity, OrderStatus, ReturnRequestEntity } from "entities/order.entity";
import { DataSource, EntityManager, Repository } from "typeorm";
import { OrdersService, tenantId } from "./orders.service";
import { CreateReturnDto } from "dto/order.dto";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";

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
                throw new NotFoundException(`Order with ID ${dto.orderId} not found.`);
            }

            const orderItemsMap = new Map(order.items.map(item => [item.id, item]));

            // 2. Validate requested items
            for (const returnItem of dto.items) {
                const originalOrderItem = orderItemsMap.get(returnItem.originalItemId);
                let errorDetail;

                if (!originalOrderItem) {
                    errorDetail = `Item ID ${returnItem.originalItemId} not found in Order ${dto.orderId}`.trim();
                } else if (returnItem.quantity > originalOrderItem.quantity) {
                    errorDetail = `Qty mismatch: Requested ${returnItem.quantity}, Purchased ${originalOrderItem.quantity}`.trim();
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
                    throw new BadRequestException(errorDetail);
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
                    notes: "Automatic: Moved to Return Preparing via return request",
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
                details: `Order ${order.orderNumber || dto.orderId} has been prepered for returned for ${dto.items.length} items.`.trim()
            });

            await this.notificationService.create({
                userId: Number(adminId),
                type: NotificationType.RETURN_REQUEST_CREATED,
                title: "Return Request Created",
                message: `A return request has been created for order #${order.orderNumber}.`,
                relatedEntityType: "order",
                relatedEntityId: String(order.id),
            });

            return savedRequest;
        });
    }
}