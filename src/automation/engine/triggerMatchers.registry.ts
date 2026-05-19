import { Injectable, NotFoundException } from "@nestjs/common";
import { TriggerType, OrderCreatedConfig, OrderUpdatedConfig } from "entities/automation.entity";
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
export class TriggerMatchersRegistry {
    private readonly matchers = new Map<TriggerType, TriggerMatcher>();

    constructor(
        private readonly orderCreatedMatcher: OrderCreatedTriggerMatcher,
        private readonly orderUpdatedMatcher: OrderUpdatedTriggerMatcher,
    ) {
        this.registerMatchers();
    }

    private registerMatchers() {
        this.matchers.set(TriggerType.ORDER_CREATED, this.orderCreatedMatcher);
        this.matchers.set(TriggerType.ORDER_UPDATED, this.orderUpdatedMatcher);
    }

    getMatcher(triggerType: TriggerType): TriggerMatcher {
        const matcher = this.matchers.get(triggerType);
        if (!matcher) {
            throw new NotFoundException(`No trigger matcher registered for trigger type: ${triggerType}`);
        }
        return matcher;
    }
}
