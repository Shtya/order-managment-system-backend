# 🏪 Store Integration Module

## Overview

The Store Integration Module enables tenants (admins) to connect their product and inventory data with external e-commerce platforms like EasyOrder, Shopify, WooCommerce, etc. This creates a seamless bi-directional sync system where orders, products, inventory, and status updates flow automatically between the dashboard and integrated stores.

**Key Concept**: The "Store" entity represents an external e-commerce platform integration for a tenant, NOT a physical store location.

---

## 📋 Table of Contents

1. [Core Concepts](#core-concepts)
2. [Database Schema](#database-schema)
3. [Complete Flow Diagrams](#complete-flow-diagrams)
4. [Feature Breakdown](#feature-breakdown)
5. [API Endpoints](#api-endpoints)
6. [Frontend Implementation](#frontend-implementation)
7. [Backend Implementation](#backend-implementation)
8. [Webhook System](#webhook-system)
9. [Sync Mechanism](#sync-mechanism)
10. [Retry & Error Handling](#retry--error-handling)
11. [Code Examples](#code-examples)
12. [Store Type Providers](#store-type-providers)

---

## 🎯 Core Concepts

### **What is a "Store" in this context?**

A **Store** is an external e-commerce platform that a tenant integrates with to:
- Sync their product catalog
- Sync product categories
- Receive new customer orders
- Update order status
- Sync inventory levels

**Examples**:
- EasyOrder (Egyptian e-commerce platform)
- Shopify (Multi-channel commerce)
- WooCommerce (WordPress e-commerce)
- Magento
- Custom API-based stores

### **Multi-Tenancy in Store Integration**

Each tenant (admin) can integrate with multiple stores independently:

```
Tenant A
├── Store 1: EasyOrder (Store ID: 1)
├── Store 2: Shopify (Store ID: 2)
└── Store 3: WooCommerce (Store ID: 3)

Tenant B
├── Store 1: EasyOrder (Store ID: 4)
└── Store 2: Shopify (Store ID: 5)
```

Each integration is isolated and has unique:
- Store ID
- API Keys
- Webhook secrets
- Sync status
- Configuration

---

## 🗄️ Database Schema

### **StoreEntity**

```typescript

@Entity({ name: "stores" })
@Index(["adminId", "code"], { unique: true })
@Index(["adminId", "name"])
@Index(["adminId", "isActive"])
export class StoreEntity {
	@PrimaryGeneratedColumn('uuid')
	Id: string;

	// Tenant ownership
	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	// Store identification
	@Column({ type: "varchar", length: 120 })
	name!: string; // e.g., "My EasyOrder Store", "Shopify Main Store"

	@Column({ type: "varchar" })
	storeUrl!: string;

	@Column({ type: "varchar", length: 50 })
	code!: string; // Slug for identification, unique per tenant

	@Column({
		type: "enum",
		enum: StoreProvider
	})
	provider!: StoreProvider;

	// Provider-specific configuration
	@Column({ type: 'text' })
	encryptedData: string; // The encrypted JSON string containing keys/tokens

	@Column({ type: 'varchar', length: 255 })
	iv: string; // Hex initialization vector

	@Column({ type: 'varchar', length: 255 })
	tag: string; // Hex auth tag for GCM integrity

	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@Column({
		type: "enum",
		enum: SyncStatus,
		default: SyncStatus.PENDING,
	})
	syncStatus!: SyncStatus;

	@Column({ type: "text", nullable: true })
	lastSyncError?: string;

	@Column({ type: "int", default: 0 })
	syncRetryCount!: number; // Number of failed sync attempts

	@Column({ type: "timestamptz", nullable: true })
	lastSyncAttemptAt?: Date;

	@Column({ type: "timestamptz", nullable: true })
	nextRetryAt?: Date; // When to retry if failed

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;

}

```

### **StoreSyncLogEntity** (for audit trail)

```typescript
@Entity({ name: "store_sync_logs" })
@Index(["storeId", "created_at"])
export class StoreSyncLogEntity {
  @PrimaryGeneratedColumn('uuid')
  Id: string;

  @Column()
  storeId!: string;

  @ManyToOne(() => StoreEntity)
  @JoinColumn({ name: "storeId" })
  store!: Relation<StoreEntity>;

  @Column({ type: "varchar", length: 50 })
  action!: "sync_products" | "sync_categories" | "update_inventory" | "update_order_status" | "receive_order";

  @Column({ type: "varchar", length: 50 })
  status!: "pending" | "in_progress" | "success" | "failed";

  @Column({ type: "text", nullable: true })
  details?: string;

  @Column({ type: "text", nullable: true })
  errorMessage?: string;

  @Column({ type: "int", default: 1 })
  retryCount!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
```

### **WebhookEventEntity** (for webhook history)

```typescript
@Entity({ name: "webhook_events" })
@Index(["storeId", "created_at"])
export class WebhookEventEntity {
  @PrimaryGeneratedColumn('uuid')
  Id: string;

  @Column()
  storeId!: string;

  @ManyToOne(() => StoreEntity)
  @JoinColumn({ name: "storeId" })
  store!: Relation<StoreEntity>;

  @Column({ type: "varchar", length: 50 })
  eventType!: "order_created" | "order_status_changed";

  @Column({ type: "varchar", length: 50, default: "pending" })
  status!: "pending" | "processed" | "failed";

  @Column({ type: "text", nullable: true })
  errorMessage?: string;

  @CreateDateColumn()
  received_at!: Date;

  @UpdateDateColumn()
  processed_at?: Date;
}
```

---

## 📊 Complete Flow Diagrams

### **1. Store Setup & Configuration Flow**

```
┌─────────────────────────────────────────────────────────────────┐
│                  TENANT ADMIN DASHBOARD                          │
│                  (Frontend - React/Next.js)                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    [Store Integration Page]
                              ↓
                  ┌───────────────────────┐
                  │  Display Store Cards  │
                  │  (Available Providers)│
                  └───────────────────────┘
                              ↓
                  ┌───────────────────────┐
                  │   Click "Add Settings"│
                  │   or "Edit Settings"  │
                  │   At store card       │
                  └───────────────────────┘
                           
                              ↓
        ┌─────────────────────────────────────────┐
        │  Store-Specific Configuration Form      │
        │  (API Key, Webhooks, etc)               │
        │   - Ask for Sync Option                 │
        └─────────────────────────────────────────┘
                              ↓
                   [Instructions Modal]
      "Go to EasyOrder > Settings > Webhooks
       Add these URLs as webhooks:
       - New Orders: [URL]
       - Order Status: [URL]
       Secret: [SECRET]"
                              ↓
                     User follows instructions
                              ↓
        [User returns and submits configuration]
                              ↓
       POST /stores (Create) or PATCH /stores/:id (Update)
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND PROCESSING                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                  ┌───────────────────────┐
                  │  Validate credentials │
                  │  & configuration      │
                  └───────────────────────┘
                              ↓
                        ✅ Success?
                         /         \
                       ✓/           \✗
                      /              \
                     ↓                ↓
          ┌───────────────────┐  ┌──────────────────┐
          │  Save Store to DB │  │  Return Error    │
          │ (isActive: true ) │  │  Message         │
          └───────────────────┘  └──────────────────┘
                     ↓
                [Return OK]

        ┌────────────────────────────┐
        │           Sync             │
        └────────────────────────────┘
                   /          \
                ✓/            \✗
              /                 \
             ↓                   ↓                                  
            |              ┌──────────┐
            |              │  Done    │
            |              └──────────┘
             ↓
        Trigger Initial Sync
        (Background Job)
             ↓
   [Sync Products + Categories]
             ↓
         ✅ Success?
          /        \
        ✓/          \✗
       /            \
      ↓              ↓
  ┌────────┐    ┌─────────────┐
  │ Done   │    │ Send Alert  │
  │   │    │    | to Tenant   │
  └────────┘    │ (with retry)│
                └─────────────┘
```

### **2. Product Sync Flow (On Product Create/Update)**

```
┌──────────────────────────────┐
│  Admin adds/updates Product  │
│  (Dashboard or API)          │
└──────────────────────────────┘
              ↓
┌──────────────────────────────┐
│  Product Saved to DB         │
│  (TypeORM fires AfterUpdate) │
└──────────────────────────────┘
              ↓
┌──────────────────────────────┐
│  ProductSyncSubscriber       │
│  (Listens for changes)       │
└──────────────────────────────┘
              ↓
    ┌──────────────────────┐
    │ Get All Active Stores│
    │ for this tenant      │
    └──────────────────────┘
              ↓
    ┌──────────────────────┐
    │  For Each Store:     │
    │  (Sequential/Parallel)
    └──────────────────────┘
              ↓
    ┌──────────────────────┐
    │ Get Store Provider   │
    │ Handler              │
    └──────────────────────┘
              ↓
    ┌──────────────────────┐
    │ Call: syncProduct()  │
    │ with product data    │
    └──────────────────────┘
              ↓
    Provider's syncProduct()
              ↓
      ┌───────────────────┐
      │ API Call to Store │
      │ (POST /products)  │
      └───────────────────┘
              ↓
          ✅ Success?
           /        \
         ✓/          \✗
        /            \
       ↓              ↓
  ┌────────┐   ┌──────────────┐
  │Log OK  │   │Log Error     │
  │Return  │   │Increment retry
  └────────┘   │Schedule retry
               │Send notification
               └──────────────┘
                     ↓
              [Exponential backoff]
              [Max 5 retries]
                     ↓
              ┌──────────────┐
              │Still failing?│
              │Send Alert to │
              │Tenant        │
              └──────────────┘
```

### **3. Order Webhook Reception Flow**

```
┌─────────────────────────────────────────┐
│  External Store (EasyOrder/Shopify)     │
│  New order placed by customer           │
└─────────────────────────────────────────┘
                     ↓
         ┌──────────────────────┐
         │  Send webhook POST   │
         │  to dashboard URL:   │
         │ /stores/webhook/:id  │
         │ with secret validation
         └──────────────────────┘
                     ↓
┌─────────────────────────────────────────┐
│  DASHBOARD BACKEND                      │
│  POST /stores/webhook/:storeCode          │
└─────────────────────────────────────────┘
                     ↓
         ┌──────────────────────┐
         │ Validate Secret      │
         │ from webhook payload │
         └──────────────────────┘
                     ↓
              ✅ Valid?
               /        \
             ✓/          \✗
            /             \
           ↓               ↓
   ┌──────────────┐  ┌──────────────┐
   │ Get Store    │  │ Return 401   │
   │ from DB      │  │ Unauthorized │
   └──────────────┘  └──────────────┘
           ↓
   ┌──────────────┐
   │ Create/Save  │
   │ WebhookEvent │
   │ (pending)    │
   └──────────────┘           
           ↓
   ┌──────────────┐
   │ Get Store    │
   │ Provider     │
   │ Handler      │
   └──────────────┘
           ↓
   ┌──────────────┐
   │ Parse order  │
   │ payload      │
   │ to OrderDTO  │
   └──────────────┘
           ↓
   ┌──────────────┐
   │ Check for    │
   │ duplicates   │
   │ (external ID)│
   └──────────────┘
           ↓
   ┌──────────────┐
   │ Create Order │
   │ in dashboard │
   │ with external│
   │ reference 
   (externalOrderId)
   └──────────────┘
           ↓
   ✅ Success?
    /        \
  ✓/          \✗
 /            \
↓              ↓
Mark OK    Retry logic
Update     (exponential backoff)
WebhookEvent 
to processed

```

### **4. Inventory Sync Flow (On Invoice)**
- almost same prevs
### **5. Order Status Update Flow**

- almost same prevs
---

## ✨ Feature Breakdown

### **1. Store Creation & Configuration**

#### **New Store Setup**
- Tenant selects provider card (EasyOrder, Shopify, etc)
- Enters provider-specific credentials (API key, webhooks, etc)
- Gets instructions to configure webhooks on external store
- Chooses whether to sync existing products/categories
- Backend validates and saves store configuration
- Store created with `isActive: true` by default

#### **Store Configuration Options by Provider**

**EasyOrder**:
```json
{
  "apiKey": "eo_xxx_xxx",
  "storeUrl": "https://store.easyorder.app/store/tenant-code",
  "webhookSecret": "secret_xxx",
  "orderWebhookId": "webhook_123",
  "statusWebhookId": "webhook_124"
}
```

---

### **2. Webhook System**

#### **Webhook URLs**

The system provides unique webhook URLs per store:

```
POST /api/stores/webhooks/:storeCode
Example: POST /api/stores/webhooks/1
```

#### **Webhook Flow**
1. External store sends POST request to webhook URL with secret signature
2. Backend validates HMAC signature with stored secret
3. Payload is stored in `WebhookEventEntity` (status: pending)
4. Returns 200 immediately to external store
5. Background job processes the event asynchronously
6. Prevents duplicate processing using idempotency keys

#### **Webhook Event Types**

**Order Webhooks**:
- `order_created` - New order placed on external store
- `order_status_changed` - Order status updated on external store

---

### **3. Initial Sync**

#### **What Gets Synced**

When a new store is created and admin chooses "Sync", the system sync all products and categories to new store:
---

### **4. Continuous Sync (Ongoing)**

After initial setup, the system continuously syncs:

#### **What Triggers Sync**

**Outbound (Dashboard → Store)**:
- Product created/updated
- Product variant created/updated
- Category created/updated
- Inventory updated (from invoice)
- Order status changed

**Inbound (Store → Dashboard)**:
- New order placed on store
- Order status changed on store

---

### **5. TypeORM Subscribers for Sync**

The system uses TypeORM subscribers (database change listeners) for automatic sync:

```typescript
// Triggered when Product or ProductVariant is saved
ProductSyncSubscriber
  → Triggers when: Save product/variant
  → Action: Sync to all active stores

// Triggered when Order status changes
OrderStatusSyncSubscriber
  → Triggers when: Update order status
  → Action: Update order status on origin store
  → Handler: Store's syncOrderStatus() method
....
```

---

### **6. Retry Mechanism & Error Handling**

#### **Automatic Retry Logic**

When a sync operation fails:

```
1st Attempt: Immediate
   ↓ (if fails)
2nd Attempt: After 5 minutes
   ↓ (if fails)
3rd Attempt: After 15 minutes
   ↓ (if fails)
4th Attempt: After 1 hour
   ↓ (if fails)
5th Attempt: After 3 hours
   ↓ (if fails)
Failure: Send alert notification to tenant
         with option to manually retry
```

#### **Retry Tracking**

Store entity tracks retry state:
```
syncRetryCount: number     // Number of failed attempts
lastSyncError: string      // Last error message
nextRetryAt: Date          // When to retry next
lastSyncAttemptAt: Date    // When last attempted
```

---

### **7. Store Re-activation Sync**

When an admin disables a store the sync disable and then re-enables it re-sync enables again:
---

## 🔌 API Endpoints

### **Store Management**

```
GET    /stores                      # List all stores for tenant
POST   /stores                      # Create new store
GET    /stores/:id                  # Get store details
PATCH  /stores/:id                  # Update store settings
DELETE /stores/:id                  # Delete store (soft delete)
PATCH  /stores/:id/activate         # Activate store (trigger sync)
PATCH  /stores/:id/deactivate       # Deactivate store
POST   /stores/:id/test-connection  # Test store credentials
GET    /stores/:id/sync-logs        # Get sync history/logs
```

### **Webhook Endpoints**

```
POST   /stores/webhooks/:storeCode/newOrder    # Receive webhook from store
PUT   /stores/webhooks/:storeCode/orderStatus    # Receive webhook from store
GET    /stores/:id/webhook-events   # View received webhook events
```

### **Manual Retry**

```
POST   /stores/:id/retry-failed-sync # Manually retry failed sync
```
---

## ✅ Key Takeaways

1. **Store Integration** = Connection to external e-commerce platforms
2. **Multi-tenancy** = Each tenant has isolated stores
3. **Sync From dashboard to store** = Products, categories, order status
3. **Sync From store to dashboard** = new order, order status
4. **Automatic Retry** = Exponential backoff with notifications
5. **Webhook System** = Real-time order updates from external stores
6. **TypeORM Subscribers** = Database triggers for automatic sync
7. **Provider Pattern** = Easy to add new store types
8. **Audit Trail** = Complete sync history logging
9. **Idempotency** = Prevent duplicate webhook processing
10. **Error Handling** = Graceful failures with notifications

---

**Last Updated**: January 2026
