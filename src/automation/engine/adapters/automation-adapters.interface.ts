import { SendWhatsappTemplateConfig, AutomationRunEntity, VariableDetails } from 'entities/automation.entity';
import { Repository, EntityManager } from 'typeorm';
import { WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { WhatsappInteractiveMessagePayload } from 'src/whatsapp/services/WhatsappApi.service';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { OrderEntity } from 'entities/order.entity';
import { User } from 'entities/user.entity';

/**
 * Execution mode for automation handlers
 */
export type ExecutionMode = 'production' | 'preview';

/**
 * Single unified adapter interface for all automation operations
 * Different implementations for production (actual side effects) vs preview (no side effects)
 */
export interface AutomationAdapter {
    /**
     * Change order status
     * In production: updates the database
     * In preview: returns mock data without side effects
     */
    changeStatus(
        user: { adminId: string; id: string | null },
        orderId: string,
        data: { statusId: string; notes?: string },
    ): Promise<{
        success: boolean;
        orderId: string;
        previousStatusId?: string;
        newStatusId: string;
        newStatusName?: string;
        previewMode?: boolean;
        skippedSideEffect?: boolean;
    }>;

    /**
     * Send WhatsApp template message
     * In production: calls Meta API via WhatsappService
     * In preview: returns mock data without side effects
     */
    sendTemplate(
        accountId: string,
        data: {
            to: string;
            templateId: string;
            headerVariables?: Record<string, any>;
            bodyVariables?: Record<string, any>;
            buttonVariables?: Record<string, any>;
            locationData: {
                latitude: string;
                longitude: string;
                address: any;
                name: any;
            };
            headerUrl?: string;
        },
        adminId?: string,
    ): Promise<{
        success: boolean;
        messageId?: string;
        recipient?: string;
        templateId?: string;
        previewMode?: boolean;
        skippedSideEffect?: boolean;
    }>;

    /**
     * Get template by ID
     * Shared between production and preview (needed for validation)
     */
    getTemplateById(templateId: string): Promise<any>;

    /**
     * Find status by ID
     * Shared between production and preview (needed for validation)
     */
    findStatusById(
        statusId: string,
        adminId: string,
        manager?: EntityManager,
    ): Promise<any>;

    /**
     * Send Upsell message
     */
    sendUpsell(
        upsell: Upsell,
        order: OrderEntity,
        run?: AutomationRunEntity,
    ): Promise<UpsellHistory | null>;

    /**
     * Get available upsells for products
     */
    getUpsellsForProducts(
      productIds: string[],
      adminId: string,
      orderItemVariantIds?: string[],
    ): Promise<Upsell[]>;

    /**
     * Manual assign order to specific employee
     */
    manualAssign(
        employeeId: string,
        order: OrderEntity,
        adminId: string,
    ): Promise<string>;

    /**
     * Process auto assignment for orders
     */
    processAutoAssignment(
        adminId: string,
         orders: OrderEntity[],
    ): Promise<{
        success?: boolean;
        message?: string;
        noActiveRules?: boolean;
        assignedCount: number;
        results?: Array<{
            orderId: string;
            orderNumber?: string;
            employeeId?: string;
            ruleName?: string;
        }>;
    }>;

    /**
     * Get active assignment rules
     */
    
}
