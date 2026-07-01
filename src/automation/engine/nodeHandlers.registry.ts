// factory pattern. A registry that holds the actual execution logic for each FlowNodeType (e.g., WhatsappHandler, UpdateOrderStatusHandler, ConditionHandler).
// The engine just says registry.execute(nodeType, hydratedConfig).

import { Inject, Injectable, Logger, NotFoundException, forwardRef } from "@nestjs/common";
import { ActionType, AssignOrderToEmployeeConfig, AutomationRunEntity, ConditionType, FlowNodeDataType, OrderCheckConfig, QuickOrderStatusConfig, SendUpsellConfig, SendWhatsappTemplateConfig, TriggerType, UpdateOrderStatusConfig } from "entities/automation.entity";
import { OrderEntity } from "entities/order.entity";
import { TemplateStatus} from "entities/whatsapp.entity";

import { evaluateCondition, getActualFieldValue } from "./automation-helpers";
import { AutomationAdapter } from "./adapters/automation-adapters.interface";
import { ProductionAutomationAdapter } from "./adapters/production.adapters";
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";

import { OrderAssignmentEntity } from "entities/assignment.entity";
import { OrdersService } from "src/orders/services/orders.service";

export interface NodeHandlerResponse {
    success: boolean;
    output?: any;
    error?: string;
    // لتحديد المسار القادم في حال كانت العقدة عبارة عن شرط (Condition)
    chosenBranch?: string;
    // هل يجب إيقاف الأتمتة مؤقتاً بعد هذه الخطوة بانتظار حدث خارجي (مثل الواتساب)؟
    shouldPause?: boolean;
}

export abstract class FlowNodeHandler {

    constructor(
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) { }
    abstract execute(config: any, run: AutomationRunEntity): Promise<NodeHandlerResponse>;

    async getOrder(orderData: any): Promise<OrderEntity> {
        const id = orderData?.id;
        const isMocked = orderData?.__mock;
        if (isMocked) {
            return orderData;
        }

        if (!id) {
            throw new Error('Order ID is required');
        }
        if (!this.orderRepo) {
            throw new Error('Order repository is not available');
        }
        const order = await this.orderRepo.findOne({
            where: { id },
            relations: ['status', 'items', 'items.variant', 'items.variant.product'],
        });
        if (!order) {
            throw new NotFoundException(`Order with ID ${id} not found`);
        }
        return order;
    }
}

@Injectable()
export class ConditionQuickOrderStatusHandler extends FlowNodeHandler {
    private readonly logger = new Logger(ConditionQuickOrderStatusHandler.name);

    constructor(
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) {
        super(orderRepo);
    }

    async execute(
        hydratedConfig: QuickOrderStatusConfig,
        run: AutomationRunEntity,
    ): Promise<NodeHandlerResponse> {
        try {
            // 1. Get latest order data from database, or use old data for preview
            let orderData = await this.getOrder(run.executionState.trigger.output);

            if (!orderData) {
                return {
                    success: false,
                    shouldPause: false,
                    error: 'The order data required for this condition is unavailable.',
                };
            }

            // 2. Compare current order status
            const currentStatusId = orderData.statusId;
            const targetStatusId = hydratedConfig.statusId;

            const isMatched =
                currentStatusId &&
                targetStatusId &&
                currentStatusId === targetStatusId;

            // 3. Choose next branch
            const chosenBranch = isMatched ? 'true' : 'false';

            return {
                success: true,
                shouldPause: false,
                chosenBranch,

                output: {
                    orderId: orderData.id,
                    orderNumber: orderData.orderNumber,

                    currentStatusId,
                    targetStatusId,

                    matched: isMatched,
                },
            };
        } catch (error) {
            this.logger.error(
                `Error executing quick order status condition: ${error?.message}`,
                error?.stack,
            );

            return {
                success: false,
                shouldPause: false,
                error:
                    'The order status condition could not be evaluated successfully.',
            };
        }
    }
}

@Injectable()
export class ConditionOrderCheckHandler extends FlowNodeHandler {
    private readonly logger = new Logger(ConditionOrderCheckHandler.name);

    constructor(
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) {
        super(orderRepo);
    }

    async execute(hydratedConfig: OrderCheckConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            // 1. جلب بيانات الطلب من قاعدة البيانات (أحدث نسخة), أو استخدم البيانات القديمة للمعاينة
            let orderData = await this.getOrder(run.executionState.trigger.output);
            if (!orderData) {
                return {
                    success: false,
                    shouldPause: false,
                    error: 'The order data required for order check condition is unavailable.',
                };
            }

            const checks = hydratedConfig.checks || [];

            let allChecksPassed = true;

            // 2. المرور على جميع الشروط (المنطق هنا هو AND: يجب أن تتطابق جميع الشروط)
            for (const check of checks) {
                const actualValue = getActualFieldValue(check.field, orderData);  // مثلاً: orderData['items_count']
                const targetValue = check.targetValue;      // القيمة المدخلة من المستخدم
                const operator = check.operator;

                const isMatch = evaluateCondition(actualValue, operator, targetValue, this.logger);

                if (!isMatch) {
                    allChecksPassed = false;
                    break; // توفير للذاكرة: إذا فشل شرط واحد، لا داعي لفحص الباقي
                }
            }

            // 3. تحديد المسار القادم بناءً على نتيجة الفحص
            const chosenBranch = allChecksPassed ? 'true' : 'false';

            return {
                success: true,
                shouldPause: false,
                chosenBranch, // 🌟 هذا هو المفتاح الذي يقرأه الـ EngineRunner ليعرف أي سهم سيتبع
                output: {
                    evaluatedChecksCount: checks.length,
                    passed: allChecksPassed,
                    orderId: orderData.id,  // للتوثيق في الـ Logs
                    orderNumber: orderData.orderNumber
                }
            };

        } catch (error) {
            this.logger.error(`Error executing Order Check condition: ${error.message}`);
            return {
                success: false,
                shouldPause: false,
                error: `Condition evaluation failed: ${error.message}`
            };
        }
    }
}

@Injectable()
export class ActionUpdateOrderStatusHandler extends FlowNodeHandler {
    private readonly logger = new Logger(ActionUpdateOrderStatusHandler.name);

    constructor(
        private readonly adapter: AutomationAdapter,
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) {
        super(orderRepo);
    }

    async execute(
        hydratedConfig: UpdateOrderStatusConfig,
        run: AutomationRunEntity,
    ): Promise<NodeHandlerResponse> {
        try {
            // 1. Get latest order data from database, or use old data for preview
            let orderData = await this.getOrder(run.executionState.trigger.output);

            if (!orderData?.id) {
                return {
                    success: false,
                    shouldPause: false,
                    error:
                        'The order information required to update the status is missing.',
                };
            }

            // 2. Validate target status
            const statusEntity = await this.adapter.findStatusById(hydratedConfig.newStatusId, orderData.adminId);

            if (!statusEntity) {
                return {
                    success: false,
                    shouldPause: false,
                    error:
                        'The selected order status no longer exists or is unavailable.',
                };
            }

            // 3. Skip if already same status
            if (orderData.statusId === statusEntity.id) {
                return {
                    success: true,
                    shouldPause: false,
                    output: {
                        skipped: true,
                        reason: 'Order already has the target status.',
                        orderId: orderData.id,
                        statusId: statusEntity.id,
                    },
                };
            }

            // 4. Execute status update using adapter
            await this.adapter.changeStatus(
                {
                    adminId: run.initialPayload?.adminId,
                    id: run.initialPayload?.userId || null,
                },
                orderData.id,
                {
                    statusId: statusEntity.id,
                    notes: `Updated automatically via automation`,
                },
            );

            // 5. Success response
            return {
                success: true,
                shouldPause: false,

                output: {
                    orderId: orderData.id,
                    orderNumber: orderData.orderNumber,

                    previousStatusId: orderData.statusId,
                    newStatusId: statusEntity.id,
                    newStatusName: statusEntity.name,
                },
            };
        } catch (error) {
            this.logger.error(
                `Failed to update order status: ${error?.message}`,
                error?.stack,
            );

            return {
                success: false,
                shouldPause: false,
                error:
                    'The order status could not be updated successfully.',
            };
        }
    }
}

@Injectable()
export class ActionSendWhatsappTemplateMessageHandler extends FlowNodeHandler {
    private readonly logger = new Logger(ActionSendWhatsappTemplateMessageHandler.name);

    // Preprocess aliases to store in a map grouped by root key (e.g., "items[]")
    private readonly pathAliasesByRoot: Map<string, { aliasPath: string; actualPath: string }> = new Map();

    // Original alias map
    private readonly pathAliases: Record<string, string> = {
        'items[].productName': 'items[].variant.product.name',
        'items[].sku': 'items[].variant.sku',
        'items[].quantity': 'items[].quantity',
        'items[].price': 'items[].unitPrice',
        'items[].unitCost': 'items[].unitCost',
        'items[].lineTotal': 'items[].lineTotal',
    };

    constructor(
        private readonly adapter: AutomationAdapter,
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) {
        super(orderRepo);
        // Initialize the optimized alias map
        for (const [aliasPath, actualPath] of Object.entries(this.pathAliases)) {
            const root = aliasPath.split('.')[0];
            this.pathAliasesByRoot.set(root, { aliasPath, actualPath });
        }
    }

    async execute(hydratedConfig: SendWhatsappTemplateConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            // Get latest order data from database, or use old data for preview
            let orderData = await this.getOrder(run.executionState.trigger.output);
            if (!orderData) {
                return { success: false, error: 'Order data not found in trigger output' };
            }

            // 1. Get Template and Account using adapter
            const template = await this.adapter.getTemplateById(hydratedConfig.templateId);

            if (!template) {
                return { success: false, error: 'WhatsApp template not found' };
            }

            if (template.adminId && !template.account) {
                return { success: false, error: 'WhatsApp account not found' };
            }

            if (template.adminId && template.status !== TemplateStatus.APPROVED) {
                return { success: false, error: 'WhatsApp template is not approved' };
            }

            const buttons = template.templateConfig.buttons || [];
            const customButtons = template.templateConfig.buttons?.filter(btn => btn.type === 'CUSTOM') || [];
            if ((customButtons.length || 0) != (hydratedConfig.branches?.length || 0)) {
                return { success: false, error: 'WhatsApp template buttons and configuration buttons count do not match' };
            }
            const bodyVarsLength = (Array.isArray(template.templateConfig.examples)
                ? template.templateConfig.examples?.length
                : Object.keys(template.templateConfig.examples || {}).length) || 0;

            const headerVarsLength = template.templateConfig.headerExample ? 1 : 0;

            if (bodyVarsLength !== Object.keys(hydratedConfig.bodyVariables || {}).length) {
                return { success: false, error: 'WhatsApp template body variables count does not match' };
            }

            const dynamicUrlButtons = buttons.filter(btn => btn.type === 'VISIT_WEBSITE' && btn.urlType === 'Dynamic');
            const configButtonVarsCount = Object.keys(hydratedConfig.buttonVariables || {}).length;

            if (dynamicUrlButtons.length !== configButtonVarsCount) {
                return { success: false, error: 'WhatsApp template dynamic URL buttons variables count does not match' };
            }

            if (headerVarsLength !== Object.keys(hydratedConfig.headerVariables || {}).length) {
                return { success: false, error: 'WhatsApp template header variables count does not match' };
            }

            // 2. Prepare Hydrated Variables (Map dynamic paths to real values)
            const headerVariables = hydratedConfig.headerVariables ? this.mapVariablesToValues(hydratedConfig.headerVariables, orderData) : undefined;
            const bodyVariables = hydratedConfig.bodyVariables ? this.mapVariablesToValues(hydratedConfig.bodyVariables, orderData) : undefined;
            const buttonVariables = hydratedConfig.buttonVariables ? this.mapVariablesToValues(hydratedConfig.buttonVariables, orderData) : undefined;

            // Handle Location Header if present
            let locationData = undefined;
            if (template.templateConfig?.headerType?.toUpperCase() === 'LOCATION' && hydratedConfig.locationData) {
                const locValues = this.mapVariablesToValues({
                    name: hydratedConfig.locationData.name,
                    address: hydratedConfig.locationData.address
                }, orderData);

                locationData = {
                    latitude: hydratedConfig.locationData.latitude?.toString(),
                    longitude: hydratedConfig.locationData.longitude?.toString(),
                    name: locValues.name,
                    address: locValues.address
                };
            }


            // 3. Determine Recipient
            const to = hydratedConfig.recipientNumber ? normalizeEgyptianPhoneNumber(hydratedConfig.recipientNumber) : orderData.normalizedPhoneNumber ? orderData.normalizedPhoneNumber : normalizeEgyptianPhoneNumber(orderData.phoneNumber);
            if (!to) {
                return { success: false, error: 'Recipient phone number not found' };
            }

            // 4. Send Message using adapter
            const adapterResponse = await this.adapter.sendTemplate(
                template.accountId,
                {
                    to,
                    templateId: template.id,
                    headerVariables,
                    bodyVariables,
                    buttonVariables,
                    locationData,
                    // headerUrl: hydratedConfig.headerUrl,
                },
                orderData.adminId,
            );

            return {
                success: true,
                shouldPause: hydratedConfig.branches?.length > 0,
                output: {
                    messageId: adapterResponse.messageId,
                    recipient: to,
                    templateId: template.id,
                    templateName: template.name,
                    variables: {
                        header: headerVariables,
                        body: bodyVariables,
                        button: buttonVariables,
                    }
                }
            };

        } catch (error) {
            this.logger.error(`Failed to send WhatsApp template: ${error.message}`, error.stack);
            return {
                success: false,
                error: `WhatsApp send failed: ${error.message}`
            };
        }
    }


    private mapVariablesToValues(variables: Record<string, any>, orderData: OrderEntity): Record<string, string> {
        const result: Record<string, string> = {};
        Object.entries(variables).forEach(([key, varDetails]) => {
            let textValue = '';

            if (varDetails.type === 'direct') {
                textValue = varDetails.value || '';
                if (!textValue) {
                    throw new Error(`Variable "${key}" is direct type but has no value`);
                }
            } else if (varDetails.type === 'variable') {
                const val = this.getValueByPath(orderData, varDetails.variablePath);
                if (Array.isArray(val)) {
                    textValue = val.map(v => String(v)).join(', ');
                } else {
                    textValue = val !== null && val !== undefined ? String(val) : '';
                }
                if (!textValue) {
                    throw new Error(`Variable "${key}" not found at path "${varDetails.variablePath}" in order data`);
                }
            }
            
            // Truncate to max 30 characters by removing words first
            textValue = this.truncateToMaxLength(textValue, 30);
            
            result[key] = textValue;
        });
        return result;
    }

    private truncateToMaxLength(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        let words = text.split(' ');
        
        // Try removing words one by one from the end until it fits
        while (words.length > 1) {
            words.pop();
            const truncated = words.join(' ');
            if (truncated.length <= maxLength) {
                return truncated;
            }
        }

        // If only one word left, truncate it directly
        return text.substring(0, maxLength);
    }

    // Helper to get value by a single path (without aliases)
    private getValueBySinglePath(obj: any, path: string): any {
        if (!path) return undefined;

        return path.split('.').reduce((acc, part) => {
            if (acc === undefined || acc === null) return undefined;

            // Handle array access like items[0] or items[-1]
            const arrayMatch = part.match(/^(\w+)\[(-?\d+)\]$/);
            if (arrayMatch) {
                const [, key, indexStr] = arrayMatch;
                const arr = acc[key];
                if (!Array.isArray(arr)) return undefined;
                let index = Number(indexStr);
                // Handle negative indices
                if (index < 0) {
                    index = arr.length + index;
                }
                return arr[index];
            }

            return acc[part];
        }, obj);
    }

    private getValueByPath(obj: any, path: string): any {
        if (!path) return undefined;

        const parts = path.split('.');

        // Iterate through path parts
        for (let i = 0; i < parts.length; i++) {
            let part = parts[i];

            // Check if part has [] suffix for array mapping
            if (part.endsWith('[]')) {
                const arrayKey = part.slice(0, -2); // Remove [] from the end
                const array = obj[arrayKey];

                if (Array.isArray(array)) {
                    // Get remaining path parts after this array part
                    const remainingPath = parts.slice(i + 1).join('.');
                    if (remainingPath) {
                        // Map each item through the remaining path
                        return array.map((item: any) => this.getValueByPath(item, remainingPath));
                    } else {
                        // Just return the array itself if no remaining path
                        return array;
                    }
                }
            } else {
                // Check if this part is an alias root
                const aliasConfig = this.pathAliasesByRoot.get(part);
                if (aliasConfig) {
                    const { aliasPath, actualPath } = aliasConfig;
                    const aliasRoot = aliasPath.split('.')[0];
                    const aliasRootWithoutBrackets = aliasRoot.endsWith('[]') ? aliasRoot.slice(0, -2) : aliasRoot;
                    const array = obj[aliasRootWithoutBrackets];

                    if (Array.isArray(array)) {
                        // Get sub-path after alias root from actual path
                        const actualRoot = actualPath.split('.')[0];
                        const actualRootWithoutBrackets = actualRoot.endsWith('[]') ? actualRoot.slice(0, -2) : actualRoot;
                        const actualSubPath = actualPath.substring(actualRoot.length + 1);
                        // Get remaining user path after the alias root part
                        const userSubPath = parts.slice(i + 1).join('.');
                        const fullActualPath = [actualSubPath, userSubPath].filter(Boolean).join('.');

                        return array.map((item: any) => this.getValueByPath(item, fullActualPath));
                    }
                }

                // Check for array access with index like [0] or [-1]
                const arrayMatch = part.match(/^(\w+)\[(-?\d+)\]$/);
                if (arrayMatch) {
                    const [, key, indexStr] = arrayMatch;
                    const arr = obj[key];
                    if (!Array.isArray(arr)) {
                        return undefined;
                    }
                    let index = Number(indexStr);
                    if (index < 0) {
                        index = arr.length + index;
                    }
                    obj = arr[index];
                    if (obj === undefined || obj === null) {
                        return undefined;
                    }
                    continue;
                }
            }

            // If not array or alias, proceed normally
            obj = obj[part];
            if (obj === undefined || obj === null) {
                return undefined;
            }
        }

        return obj;
    }
}


@Injectable()
export class ActionSendUpsellHandler extends FlowNodeHandler {
    private readonly logger = new Logger(this.constructor.name);
    constructor(
        private readonly adapter: AutomationAdapter,
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
    ) {
        super(orderRepo);
    }

    async execute(hydratedConfig: SendUpsellConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            // Get latest order data from database, or use old data for preview
            let orderData = await this.getOrder(run.executionState.trigger.output);
            if (!orderData) {
                return { success: false, error: 'Order data not found in trigger output' };
            }

            const items = orderData.items || [];
            const productIds = items.map(item => item.variant?.productId).filter(Boolean);

            if (productIds.length === 0) {
                return { success: true, shouldPause: false, chosenBranch: 'skipped', output: { reason: 'No products in order' } };
            }

            // Get available upsells for these products using adapter
            const orderItemVariantIds = items.map(item => item.variantId).filter(Boolean);
            const upsells = await this.adapter.getUpsellsForProducts(productIds, orderData.adminId, orderItemVariantIds);

            if (upsells.length === 0) {
                return { success: true, shouldPause: false, chosenBranch: 'skipped', output: { reason: 'No upsells found for products' } };
            }
            
            const sentUpsells = [];

            // Send each upsell using the adapter
            for (const upsell of upsells) {
                
                const history = await this.adapter.sendUpsell(upsell, orderData, run);
                if (history) {
                    sentUpsells.push({
                        upsellId: upsell.id,
                        historyId: history.id,
                        messageId: history.messageId,
                        triggerProductId: upsell.triggerProductId,
                        upsellProductId: upsell.upsellProductId
                    });
                }
            }

            return {
                success: true,
                shouldPause: true, // We are waiting for a response
                output: {
                    sentUpsellsCount: sentUpsells.length,
                    sentUpsells,
                    recipient: orderData.phoneNumber
                }
            };

        } catch (error) {
            this.logger.error(`Failed to send upsells: ${error.message}`, error.stack);
            return {
                success: false,
                error: `Upsell send failed: ${error.message}`
            };
        }
    }
}


@Injectable()
export class ActionAssignOrderToEmployeeHandler extends FlowNodeHandler {
    private readonly logger = new Logger(ActionAssignOrderToEmployeeHandler.name);

    constructor(
        private readonly adapter: AutomationAdapter,
        @InjectRepository(OrderEntity)
        protected readonly orderRepo: Repository<OrderEntity>,
        @InjectRepository(OrderAssignmentEntity)
        private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
        private readonly ordersService: OrdersService,
    ) {
        super(orderRepo);
    }

    async execute(config: AssignOrderToEmployeeConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            // Get latest order data
            let orderData = await this.getOrder(run.executionState.trigger.output);
            if (!orderData?.id) {
                return {
                    success: false,
                    shouldPause: false,
                    error: 'Order data not available for assignment',
                };
            }
            const adminId = orderData.adminId;

            // Check if order is eligible for assignment
            if (orderData.status && !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(orderData.status.code as any)) {
                return {
                    success: true,
                    shouldPause: false,
                    chosenBranch: 'not_eligable',
                    output: { reason: 'Order status not allowed for assignment', orderId: orderData.id }
                };
            }

            // Check if order already has active assignment
            const existingAssignment = await this.orderAssignmentRepo.findOne({
                where: { orderId: orderData.id, isAssignmentActive: true }
            });
            if (existingAssignment) {
                return {
                    success: true,
                    shouldPause: false,
                    chosenBranch: 'assigned',
                    output: { reason: 'Order already assigned', orderId: orderData.id, employeeId: existingAssignment.employeeId }
                };
            }

            let chosenBranch: string;
            let output: any;

            if (config.employeeId && config.employeeId !== 'none') {
                // Manual assignment to specific employee
                chosenBranch = await this.adapter.manualAssign(config.employeeId, orderData, adminId);
                output = { orderId: orderData.id, employeeId: config.employeeId };
            } else {
                // Auto assignment
                const result = await this.adapter.processAutoAssignment(adminId, [orderData]);
                if (result.assignedCount > 0) {
                    chosenBranch = 'assigned';
                    output = { orderId: orderData.id, results: result.results };
                } else {
                    chosenBranch = 'no_roles_match';
                    output = { orderId: orderData.id, reason: result.message || 'No matching assignment rules' };
                }
            }

            return {
                success: true,
                shouldPause: false,
                chosenBranch,
                output,
            };
        } catch (error) {
            this.logger.error(
                `Failed to assign order: ${error?.message}`,
                error?.stack,
            );

            return {
                success: false,
                shouldPause: false,
                error: 'Failed to assign order',
            };
        }
    }


}

@Injectable()
export class NodeHandlersRegistry {
    private readonly handlers = new Map<FlowNodeDataType, FlowNodeHandler>();

    constructor(
        private readonly adapter: ProductionAutomationAdapter,
        @InjectRepository(OrderEntity)
        private readonly orderRepo: Repository<OrderEntity>,
        @InjectRepository(OrderAssignmentEntity)
        private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
    ) {
        this.registerHandlers();
    }

    private registerHandlers() {
        // Create handlers with the adapter and order repo
        this.handlers.set(ConditionType.QUICK_ORDER_STATUS, new ConditionQuickOrderStatusHandler(this.orderRepo));
        this.handlers.set(ConditionType.ORDER_CHECK, new ConditionOrderCheckHandler(this.orderRepo));
        this.handlers.set(ActionType.UPDATE_ORDER_STATUS, new ActionUpdateOrderStatusHandler(this.adapter, this.orderRepo));
        this.handlers.set(ActionType.SEND_WHATSAPP_TEMPLATE, new ActionSendWhatsappTemplateMessageHandler(this.adapter, this.orderRepo));
        this.handlers.set(ActionType.SEND_UPSELL, new ActionSendUpsellHandler(this.adapter, this.orderRepo));
        this.handlers.set(ActionType.ASSIGN_ORDER_TO_EMPLOYEE, new ActionAssignOrderToEmployeeHandler(this.adapter, this.orderRepo, this.orderAssignmentRepo, this.ordersService));
    }

    /**
     * الدالة التي يستدعيها المحرك (EngineRunnerService) لجلب المعالج
     */
    getHandler(nodeType: FlowNodeDataType): FlowNodeHandler {
        const handler = this.handlers.get(nodeType);

        if (!handler) {
            throw new NotFoundException(`No execution handler registered for node type: ${nodeType}`);
        }

        return handler;
    }
}