import { SendWhatsappTemplateConfig } from 'entities/automation.entity';
import { Repository, EntityManager } from 'typeorm';
import { WhatsappTemplateEntity } from 'entities/whatsapp.entity';

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
   * In production: calls Meta API
   * In preview: returns mock data without side effects
   */
  sendTemplateFromEntity(
    accountId: string,
    data: {
      to: string;
      template: any;
      components?: any[];
    },
  ): Promise<{
    success: boolean;
    messageId?: string;
    recipient?: string;
    templateId?: string;
    templateName?: string;
    previewMode?: boolean;
    skippedSideEffect?: boolean;
    variables?: {
      header?: any;
      body?: any;
      button?: any;
    };
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
}
