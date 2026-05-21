import { Logger } from '@nestjs/common';
import { FlowEdge } from 'entities/automation.entity';
import { OrderEntity } from 'entities/order.entity';

/**
 * Shared helper functions for automation engine (both production and preview)
 */

/**
 * Find the next node ID in the flow based on edges and optional source handle (for branching)
 */
export function findNextNodeId(edges: FlowEdge[], currentNodeId: string, sourceHandle?: string): string | null {
    const edge = edges.find(e => {
        if (sourceHandle) {
            return e.source === currentNodeId && e.sourceHandle === sourceHandle;
        }
        return e.source === currentNodeId;
    });
    return edge ? edge.target : null;
}

/**
 * Get the actual field value from order data based on field name
 * Handles special cases like shippingCompany, productsTotal, items_count
 */
export function getActualFieldValue(field: string, orderData: OrderEntity | any): any {
    switch (field) {
        case 'shippingCompany':
            return orderData.shippingCompanyId;
        case 'productsTotal':
            return orderData.productsTotal;
        case 'items_count':
            return orderData.items?.length || orderData.items?.length || 0;
        default:
            return orderData[field] || orderData[field?.toLowerCase()];
    }
}

/**
 * Evaluate a condition between actual and target values using the specified operator
 * Supports: ==, !=, >, <, >=, <=, contains, not_contains, starts_with
 */
export function evaluateCondition(
    actualValue: any,
    operator: string,
    targetValue: any,
    logger?: Logger
): boolean {
    // تحويل القيم كنصوص لتسهيل مقارنة الـ IDs وحماية من قيم الـ null/undefined
    const actualStr = actualValue !== null && actualValue !== undefined ? String(actualValue).trim() : '';
    const targetStr = targetValue !== null && targetValue !== undefined ? String(targetValue).trim() : '';

    // تجهيز القيم كأرقام في حال كان الـ Operator رياضي (مثل الأكبر والأصغر)
    const actualNum = Number(actualValue);
    const targetNum = Number(targetValue);

    switch (operator) {
        // 1. المعاملات العامة (النصوص، القوائم Select، والـ Booleans)
        case '==':
            return actualStr === targetStr; // استخدام === مع String يضمن تطابق الـ Boolean والأرقام بشكل آمن
        case '!=':
            return actualStr !== targetStr;

        // 2. المعاملات الرياضية (للحقول مثل items_count و productsTotal)
        case '>':
            return !isNaN(actualNum) && !isNaN(targetNum) && actualNum > targetNum;
        case '<':
            return !isNaN(actualNum) && !isNaN(targetNum) && actualNum < targetNum;
        case '>=':
            return !isNaN(actualNum) && !isNaN(targetNum) && actualNum >= targetNum;
        case '<=':
            return !isNaN(actualNum) && !isNaN(targetNum) && actualNum <= targetNum;

        // 3. معاملات البحث النصي (للحقول مثل city و discount)
        case 'contains':
            return actualStr.toLowerCase().includes(targetStr.toLowerCase());
        case 'not_contains':
            return !actualStr.toLowerCase().includes(targetStr.toLowerCase());
        case 'starts_with':
            return actualStr.toLowerCase().startsWith(targetStr.toLowerCase());

        default:
            if (logger) {
                logger.warn(`Unknown operator used in condition step: ${operator}`);
            }
            return false;
    }
}
