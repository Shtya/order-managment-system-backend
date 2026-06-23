

export enum QueueNames {
  AUTO_ASSIGNMENT = 'auto-assignment',
  PRODUCT_SYNC = 'product-sync',
  ORDER_SYNC = 'order-sync',
  AUTOMATIONS = 'automations',
}

export const QueueConfigs: Record<QueueNames, { displayName: string; description: string }> = {
  [QueueNames.AUTO_ASSIGNMENT]: {
    displayName: 'Auto Assignment Queue',
    description: 'Handles automatic order assignment to employee based on configured rules',
  },
  [QueueNames.PRODUCT_SYNC]: {
    displayName: 'Product Sync Queue',
    description: 'Synchronizes products, categories, bundles, and full store data with external stores',
  },
  [QueueNames.ORDER_SYNC]: {
    displayName: 'Order Sync Queue',
    description: 'Creates bulk orders, syncs order statuses, retries failed orders, and processes bulk shipping tasks',
  },
  [QueueNames.AUTOMATIONS]: {
    displayName: 'Automations Queue',
    description: 'Runs automation flows and resumes them from WhatsApp or upsell replay events',
  },
};

export const AutoAssignmentJobs = {
  ASSIGN_ORDERS: 'assign-orders'
} as const;

export const ProductSyncJobs = {
  SYNC_CATEGORY: 'sync-category',
  SYNC_PRODUCT: 'sync-product',
  SYNC_BUNDLE: 'sync-bundle',
  FULL_SYNC: 'full-sync',
  SYNC_LOCAL: 'sync-local',
} as const;

export const OrderSyncJobs = {
  BULK_CREATE_ORDERS: 'bulk-create-orders',
  SYNC_ORDER_STATUS: 'sync-order-status',
  RETRY_FAILED_ORDER: 'retry-failed-order',
  BULK_SHIPPING: 'bulk-shipping',
} as const;

export const AutomationJobs = {
  START: 'start',
  RESUME: 'resume',
} as const;
