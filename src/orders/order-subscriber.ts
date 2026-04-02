import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
} from 'typeorm';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderEntity, OrderFlowPath, OrderRetrySettingsEntity, OrderStatus, PaymentStatus } from 'entities/order.entity';
import { Repository } from 'typeorm';
import { StoresService } from 'src/stores/stores.service';
import { ShippingService } from 'src/shipping/shipping.service';
import { OrdersService } from 'src/orders/services/orders.service';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';

@EventSubscriber()
@Injectable()
export class OrderSubscriber implements EntitySubscriberInterface<OrderEntity> {
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => StoresService))
        private readonly storesService: StoresService,
        @Inject(forwardRef(() => ShippingService))
        private readonly shippingService: ShippingService,
        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
        private readonly notificationService: NotificationService,
    ) {
        // Register this subscriber in the TypeORM lifecycle
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return OrderEntity;
    }

    /**
     * Called AFTER an order is updated.
     * We track the change of 'status' specifically.
     */
    async afterUpdate(event: UpdateEvent<OrderEntity>) {
        // Check if the status column was actually updated
        const isStatusChanged = event.updatedColumns.some(
            (column) => column.propertyName === 'status'
        );

        if (isStatusChanged && event.entity) {
            // event.entity contains the updated fields
            const fullOrder = await event.manager.findOne(OrderEntity, {
                where: { id: event.entity.id },
                relations: ['status']
            });

            if (!fullOrder) return;

            // Fetch settings directly using adminId

            // 1. Sync status to external stores if needed
            if (fullOrder.externalId) {
                await this.storesService.syncOrderStatus(fullOrder);
            }

            const settings = await event.manager.findOne(OrderRetrySettingsEntity, {
                where: { adminId: fullOrder.adminId }
            });
            // 2. Auto-send to shipping automation
            if (settings) {
                await this.handleAutoShipping(fullOrder, settings);
            }
        }
    }

    private async handleAutoShipping(order: OrderEntity, settings: OrderRetrySettingsEntity) {
        let shouldTrigger = false;
        let companyId: number | null = null;

        const activeResult = await this.shippingService.activeIntegrations({ adminId: order.adminId });
        const activeIntegrations = activeResult.integrations || [];

        if (activeIntegrations.length === 1) {
            if (settings.orderFlowPath === OrderFlowPath.SHIPPING && (order.status?.name === settings.shipping.triggerStatus || String(order.status?.id) === settings.shipping.triggerStatus)) {
                shouldTrigger = true;
                companyId = activeIntegrations[0].providerId;
            }
            else if (settings.orderFlowPath === OrderFlowPath.WAREHOUSE) {
                companyId = activeIntegrations[0].providerId;
            }
        } else {
            // Standard logic for multiple or no integrations
            if (settings.orderFlowPath === OrderFlowPath.SHIPPING) {
                // 1. Classic Shipping Flow trigger
                if (order.status?.name === settings.shipping.triggerStatus || String(order.status?.id) === settings.shipping.triggerStatus) {
                    shouldTrigger = true;
                    companyId = settings.shipping.shippingCompanyId;
                }
            } else if (settings.orderFlowPath === OrderFlowPath.WAREHOUSE) {
                // 2. Warehouse Flow trigger (Auto-ship after packing)
                if (settings.shipping.autoShipAfterWarehouse && (order.status?.code === OrderStatus.CONFIRMED)) {
                    shouldTrigger = true;
                    companyId = settings.shipping.warehouseDefaultShippingCompanyId;
                }
            }
        }

        if (!shouldTrigger || !companyId) return;

        // Check if already sent to shipping (has tracking or shipping company assigned)
        if (order.trackingNumber) return;

        // Payment validation
        if (settings.orderFlowPath === OrderFlowPath.SHIPPING) {

            const { requireFullPayment, partialPaymentThreshold } = settings.shipping;

            if (requireFullPayment) {
                if (order.paymentStatus !== PaymentStatus.PAID) {
                    await this.logAndNotifyFailure(order, "Order must be fully paid before auto-shipping.");
                    return;
                }
            } else if (partialPaymentThreshold > 0) {
                // partialPaymentThreshold is now a percentage
                const total = Number(order.finalTotal || 0);
                const deposit = Number(order.deposit || 0);
                const paidPercentage = total > 0 ? (deposit / total) * 100 : 0;

                if (paidPercentage < partialPaymentThreshold) {
                    await this.logAndNotifyFailure(order, `Deposit (${paidPercentage.toFixed(2)}%) is below the required threshold (${partialPaymentThreshold}%).`);
                    return;
                }
            }
        }

        // Trigger shipping
        try {
            const company = await this.dataSource.getRepository('ShippingCompanyEntity').findOne({
                where: { id: companyId }
            });

            if (!company) {
                await this.logAndNotifyFailure(order, "Configured shipping company not found.");
                return;
            }

            // Call createShipment from ShippingService
            // Mocking 'me' object for the service
            const systemUser = { id: 0, adminId: order.adminId, role: { name: 'admin' } };
            await this.shippingService.createShipment(
                systemUser,
                company.code as any,
                {}, // empty dto for defaults
                order.id,
                { emitSocket: true }
            );

            // Notify success
            await this.notificationService.create({
                userId: Number(order.adminId), // Notify the admin
                type: NotificationType.SHIPPING_AUTO_SENT,
                title: "Auto-Shipping Success",
                message: `Order #${order.orderNumber} has been automatically sent to ${company.name}.`,
                relatedEntityType: "order",
                relatedEntityId: String(order.id)
            });

            // Auto-generate label if configured
            if (settings.shipping.autoGenerateLabel) {
                try {
                    await this.ordersService.bulkPrint(systemUser, [order.orderNumber]);
                } catch (printError) {
                    console.error("Auto-generate label failed:", printError);
                    // Optionally notify about print failure, but don't fail the whole shipping process
                }
            }

        } catch (error) {
            console.error("Auto-shipping failed:", error);
            await this.logAndNotifyFailure(order, `Auto-shipping failed: ${error.message}`);
        }
    }

    private async logAndNotifyFailure(order: OrderEntity, reason: string) {
        await this.notificationService.create({
            userId: Number(order.adminId),
            type: NotificationType.SHIPPING_AUTO_FAILED,
            title: "Auto-Shipping Failed",
            message: `Order #${order.orderNumber} failed auto-shipping: ${reason}`,
            relatedEntityType: "order",
            relatedEntityId: String(order.id)
        });
    }
}