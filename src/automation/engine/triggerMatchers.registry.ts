import { Injectable, NotFoundException } from "@nestjs/common";
import { TriggerType, OrderCreatedConfig, OrderUpdatedConfig, ShipmentUpdatedConfig, ShipmentCreatedConfig } from "entities/automation.entity";
import { OrderEntity } from "entities/order.entity";

export interface TriggerMatcher {
    shouldRun(config: any, payload: any): boolean;
}

@Injectable()
export class OrderCreatedTriggerMatcher implements TriggerMatcher {
    shouldRun(config: OrderCreatedConfig, payload: OrderEntity): boolean {
        // Store filter
        if (config.storeId && payload.storeId !== config.storeId) {
            return false;
        }
        return true;
    }
}

@Injectable()
export class OrderUpdatedTriggerMatcher implements TriggerMatcher {
    shouldRun(config: OrderUpdatedConfig, payload: OrderEntity): boolean {
        // Status filter
        if (config.statusId && payload.statusId !== config.statusId) {
            return false;
        }
        return true;
    }
}

@Injectable()
export class ShipmentCreatedTriggerMatcher implements TriggerMatcher {
    shouldRun(config: ShipmentCreatedConfig, payload: OrderEntity): boolean {
    
         if (config.shippingCompanyId && payload.shippingCompanyId !== config.shippingCompanyId) {
            return false;
        }

        return true;
    }
}

@Injectable()
export class ShipmentUpdatedTriggerMatcher implements TriggerMatcher {
    shouldRun(config: ShipmentUpdatedConfig, payload: OrderEntity): boolean {
        if (!config.shipmentStatus || !payload) {
            return false;
        }

        // Active assignment is already present on the payload!
        const activeShipment = payload.shipments?.[0];
        if (!activeShipment) {
            return false;
        }

        const currentStatus = activeShipment.status;

        if (Array.isArray(config.shipmentStatus)) {
            return config.shipmentStatus.includes(currentStatus);
        }

        return currentStatus === config.shipmentStatus;
    }
}


@Injectable()
export class TriggerMatchersRegistry {
    private readonly matchers = new Map<TriggerType, TriggerMatcher>();

    constructor(
        private readonly orderCreatedMatcher: OrderCreatedTriggerMatcher,
        private readonly orderUpdatedMatcher: OrderUpdatedTriggerMatcher,
        private readonly shipmentCreatedMatcher: ShipmentCreatedTriggerMatcher,
        private readonly shipmentUpdatedMatcher: ShipmentUpdatedTriggerMatcher,
    ) {
        this.registerMatchers();
    }

    private registerMatchers() {
        this.matchers.set(TriggerType.ORDER_CREATED, this.orderCreatedMatcher);
        this.matchers.set(TriggerType.ORDER_UPDATED, this.orderUpdatedMatcher);
        this.matchers.set(TriggerType.SHIPMENT_CREATED, this.shipmentCreatedMatcher);
        this.matchers.set(TriggerType.SHIPMENT_UPDATED, this.shipmentUpdatedMatcher);
    }

    getMatcher(triggerType: TriggerType): TriggerMatcher {
        const matcher = this.matchers.get(triggerType);
        if (!matcher) {
            throw new NotFoundException(`No trigger matcher registered for trigger type: ${triggerType}`);
        }
        return matcher;
    }
}
