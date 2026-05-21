// factory pattern. A registry that holds the actual execution logic for each FlowNodeType (e.g., WhatsappHandler, UpdateOrderStatusHandler, ConditionHandler).
// The engine just says registry.execute(nodeType, hydratedConfig).

import { forwardRef, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ActionType, AutomationRunEntity, ConditionType, FlowNodeDataType, OrderCheckConfig, QuickOrderStatusConfig, SendWhatsappTemplateConfig, TriggerType, UpdateOrderStatusConfig } from "entities/automation.entity";
import { OrderEntity } from "entities/order.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { WhatsappApiService } from "src/whatsapp/services/WhatsappApi.service";
import { InjectRepository } from "@nestjs/typeorm";
import { TemplateStatus, WhatsappTemplateEntity } from "entities/whatsapp.entity";
import { Repository } from "typeorm";
import { WhatsappTemplateComponent } from "src/whatsapp/services/WhatsappApi.service";
import { evaluateCondition, getActualFieldValue } from "./automation-helpers";
import { AutomationAdapter } from "./adapters/automation-adapters.interface";
import { ProductionAutomationAdapter } from "./adapters/production.adapters";

export interface NodeHandlerResponse {
    success: boolean;
    output?: any;
    error?: string;
    // لتحديد المسار القادم في حال كانت العقدة عبارة عن شرط (Condition)
    chosenBranch?: string;
    // هل يجب إيقاف الأتمتة مؤقتاً بعد هذه الخطوة بانتظار حدث خارجي (مثل الواتساب)؟
    shouldPause?: boolean;
}

export interface FlowNodeHandler {
    execute(config: any, run: AutomationRunEntity): Promise<NodeHandlerResponse>;
}

@Injectable()
export class ConditionQuickOrderStatusHandler implements FlowNodeHandler {
    private readonly logger = new Logger(ConditionQuickOrderStatusHandler.name);

    async execute(
        hydratedConfig: QuickOrderStatusConfig,
        run: AutomationRunEntity,
    ): Promise<NodeHandlerResponse> {
        try {
            // 1. Get order data from trigger payload
            const orderData = run.executionState.trigger.output as OrderEntity;

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
export class ConditionOrderCheckHandler implements FlowNodeHandler {
    private readonly logger = new Logger(ConditionOrderCheckHandler.name);

    async execute(hydratedConfig: OrderCheckConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            // 1. جلب بيانات الطلب من مصدرها (الـ Trigger)
            // يُفترض أن بيانات الطلب موجودة هنا بناءً على بنية الـ executionState
            const orderData = run.executionState.trigger.output || {} as OrderEntity;
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
export class ActionUpdateOrderStatusHandler implements FlowNodeHandler {
    private readonly logger = new Logger(ActionUpdateOrderStatusHandler.name);

    constructor(
        private readonly adapter: AutomationAdapter,
    ) {}

    async execute(
        hydratedConfig: UpdateOrderStatusConfig,
        run: AutomationRunEntity,
    ): Promise<NodeHandlerResponse> {
        try {
            // 1. Get order data from trigger payload
            const orderData = run.executionState.trigger.output as OrderEntity;

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
                    notes: `Updated automatically via automation "${run.automationFlowId}"`,
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
export class ActionSendWhatsappTemplateMessageHandler implements FlowNodeHandler {
    private readonly logger = new Logger(ActionSendWhatsappTemplateMessageHandler.name);

    constructor(
        private readonly adapter: AutomationAdapter,
    ) {}

    async execute(hydratedConfig: SendWhatsappTemplateConfig, run: AutomationRunEntity): Promise<NodeHandlerResponse> {
        try {
            const orderData = run.executionState.trigger.output as OrderEntity;
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

            // 2. Prepare Variables
            const components: WhatsappTemplateComponent[] = [];

            if (hydratedConfig.headerVariables) {
                const headerParams = this.mapVariablesToParams(hydratedConfig.headerVariables, orderData);
                if (headerParams.length > 0) {
                    components.push({ type: 'header', parameters: headerParams });
                }
            }

            if (hydratedConfig.bodyVariables) {
                const bodyParams = this.mapVariablesToParams(hydratedConfig.bodyVariables, orderData);
                if (bodyParams.length > 0) {
                    components.push({ type: 'body', parameters: bodyParams });
                }
            }

            if (hydratedConfig.buttonVariables && configButtonVarsCount > 0) {
                Object.entries(hydratedConfig.buttonVariables).forEach(([buttonIndex, varDetails]: [string, any]) => {

                    const singleButtonParamContainer = this.mapVariablesToParams({ [buttonIndex]: varDetails }, orderData);

                    if (singleButtonParamContainer && singleButtonParamContainer.length > 0) {
                        components.push({
                            type: 'button',
                            sub_type: 'url',
                            index: String(buttonIndex), // الترتيب الصِفري للزر في مصفوفة أزرار ميتا
                            parameters: [
                                {
                                    type: 'text',
                                    text: singleButtonParamContainer[0].text // النص الديناميكي المستبدل (كود التتبع، الرقم التعريفي.. إلخ)
                                }
                            ]
                        });
                    }
                });
            }


            // 3. Determine Recipient
            const to = hydratedConfig.recipientNumber || orderData.phoneNumber;
            if (!to) {
                return { success: false, error: 'Recipient phone number not found' };
            }

            // 4. Send Message using adapter
            const adapterResponse = await this.adapter.sendTemplateFromEntity(
                template.accountId,
                {
                    to,
                    template,
                    components: components.length > 0 ? components : undefined,
                },
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
                        header: hydratedConfig.headerVariables,
                        body: hydratedConfig.bodyVariables,
                        button: hydratedConfig.buttonVariables,
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

    private mapVariablesToParams(variables: Record<string, any>, orderData: OrderEntity): any[] {
        // Sort keys numerically to match {{1}}, {{2}}...
        const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
        return keys.map(key => {
            const varDetails = variables[key];
            let textValue = '';

            if (varDetails.type === 'direct') {
                textValue = varDetails.value || '';
            } else if (varDetails.type === 'variable') {
                const val = this.getValueByPath(orderData, varDetails.variablePath);
                if (Array.isArray(val)) {
                    textValue = val.map(v => String(v)).join(', ');
                } else {
                    textValue = val !== null && val !== undefined ? String(val) : '';
                }
            }

            return { type: 'text', text: textValue };
        });
    }

    private getValueByPath(obj: any, path: string): any {
        if (!path) return undefined;

        return path.split('.').reduce((acc, part) => {
            if (acc === undefined || acc === null) return undefined;

            // Handle array access like items[0]
            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                const [, key, index] = arrayMatch;
                const arr = acc[key];
                return Array.isArray(arr) ? arr[Number(index)] : undefined;
            }

            return acc[part];
        }, obj);
    }
}


@Injectable()
export class NodeHandlersRegistry {
    private readonly handlers = new Map<FlowNodeDataType, FlowNodeHandler>();

    constructor(
        private readonly adapter: ProductionAutomationAdapter,
    ) {
        this.registerHandlers();
    }

    private registerHandlers() {
        // Create handlers with the adapter
        this.handlers.set(ConditionType.QUICK_ORDER_STATUS, new ConditionQuickOrderStatusHandler());
        this.handlers.set(ConditionType.ORDER_CHECK, new ConditionOrderCheckHandler());
        this.handlers.set(ActionType.UPDATE_ORDER_STATUS, new ActionUpdateOrderStatusHandler(this.adapter));
        this.handlers.set(ActionType.SEND_WHATSAPP_TEMPLATE, new ActionSendWhatsappTemplateMessageHandler(this.adapter));
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