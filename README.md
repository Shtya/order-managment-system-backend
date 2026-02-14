# Order Management System

A comprehensive full-stack order management system with role-based access control, multi-language support, inventory management, and supplier integration. The application is designed for managing orders, products, suppliers, warehouses, and sales with advanced features for payments, returns, and accounting.

---

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Modules](#modules)
5. [Authentication & Authorization](#authentication--authorization)
6. [Database Schema](#database-schema)
7. [Key Features](#key-features)
8. [Getting Started](#getting-started)
9. [API Endpoints](#api-endpoints)
10. [User Roles & Permissions](#user-roles--permissions)
11. [Data Flow](#data-flow)

---

## 🎯 Project Overview

The **Order Management System** is an enterprise-level application that enables businesses to:

- **Manage Orders**: Create, track, and fulfill customer orders
- **Inventory Control**: Track products, SKUs, stock levels, and warehouse locations
- **Supplier Management**: Manage supplier relationships, purchases, and returns
- **Financial Tracking**: Handle payments, refunds, and accounting
- **Multi-tenancy**: Support multiple admin accounts with their own data isolation
- **Internationalization**: Support for Arabic (ar) and English (en) languages
- **Role-Based Access Control (RBAC)**: Three-tier permission system (Super Admin, Admin, User)

---

## 🛠️ Tech Stack

### **Backend**
- **Framework**: NestJS 10 (Node.js)
- **Language**: TypeScript
- **Database**: PostgreSQL with TypeORM
- **Authentication**: JWT + Firebase Admin SDK
- **Email**: Nodemailer (Gmail)
- **File Upload**: Multer + Sharp (image processing)
- **Data Validation**: Class-Validator & Class-Transformer
- **Documentation**: Postman collection included
- **Scheduling**: NestJS Schedule

### **Frontend**
- **Framework**: Next.js 15 with Turbopack
- **Language**: JavaScript/React 19
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI (accessible components)
- **State Management**: React Query (TanStack Query)
- **Forms**: React Hook Form + Yup validation
- **Internationalization**: next-intl (i18n)
- **Map**: Leaflet + React-Leaflet
- **Animations**: Framer Motion + GSAP + AOS
- **HTTP Client**: Axios
- **Icons**: Lucide React
- **Authentication**: Firebase + JWT
- **Notifications**: React Hot Toast

---

## 📁 Project Structure

```
order-managment-system/
├── order-managment-system-backend/    # NestJS Backend
│   ├── src/
│   │   ├── main.ts                    # App entry point
│   │   ├── app.module.ts              # Root module
│   │   ├── seeder.ts                  # Database seeding
│   │   ├── auth/                      # Authentication module
│   │   ├── users/                     # User management
│   │   ├── roles/                     # Role management
│   │   ├── permissions/               # Permission management
│   │   ├── orders/                    # Order management
│   │   ├── products/                  # Product & SKU management
│   │   ├── category/                  # Product categories
│   │   ├── supplier/                  # Supplier management
│   │   ├── purchases/                 # Purchase orders
│   │   ├── purchases-return/          # Purchase returns
│   │   ├── sales_invoice/             # Sales invoices
│   │   ├── stores/                    # Store management
│   │   ├── warehouse/                 # Warehouse management
│   │   ├── bundles/                   # Product bundles
│   │   ├── plans/                     # Subscription plans
│   │   ├── asset/                     # Asset management
│   │   ├── lookups/                   # Reference data
│   │   └── transactions/              # Transaction tracking
│   ├── entities/                      # Database entities
│   │   ├── user.entity.ts             # User, Role, Permission
│   │   ├── order.entity.ts            # Order & OrderItem
│   │   ├── sku.entity.ts              # Product & ProductVariant
│   │   ├── supplier.entity.ts         # Supplier
│   │   ├── categories.entity.ts       # Category
│   │   ├── plans.entity.ts            # Plan & Transaction
│   │   ├── purchase.entity.ts         # Purchase
│   │   ├── purchase_return.entity.ts  # Purchase Return
│   │   ├── sales_invoice.entity.ts    # Sales Invoice
│   │   ├── stores.entity.ts           # Store
│   │   ├── warehouses.entity.ts       # Warehouse
│   │   ├── assets.entity.ts           # Asset
│   │   └── bundle.entity.ts           # Bundle
│   ├── dto/                           # Data Transfer Objects
│   ├── common/                        # Shared utilities
│   │   ├── base.service.ts            # Base service class
│   │   ├── crud.service.ts            # CRUD utilities
│   │   ├── enums.ts                   # Global enums
│   │   ├── permissions.decorator.ts   # @Permissions() decorator
│   │   ├── permissions.guard.ts       # Permission guard
│   │   ├── nodemailer.ts              # Email service
│   │   ├── multer.config.ts           # File upload config
│   │   ├── upload.config.ts           # Upload utilities
│   │   └── QueryFailedErrorFilter.ts  # Error handling
│   ├── uploads/                       # User uploaded files
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env                           # Environment variables
│   ├── postman.json                   # API documentation
│   └── nest-cli.json
│
├── order-managment-system-frontend/   # Next.js Frontend
│   ├── src/
│   │   ├── middleware.js              # i18n middleware
│   │   ├── app/
│   │   │   ├── [locale]/
│   │   │   │   ├── layout.js          # Root layout
│   │   │   │   ├── page.jsx           # Dashboard/home
│   │   │   │   ├── auth/              # Login, register
│   │   │   │   ├── orders/            # Orders management
│   │   │   │   ├── products/          # Products management
│   │   │   │   ├── purchases/         # Purchases management
│   │   │   │   ├── suppliers/         # Suppliers management
│   │   │   │   ├── warehouse/         # Warehouse management
│   │   │   │   ├── employees/         # Employee management
│   │   │   │   ├── plans/             # Subscription plans
│   │   │   │   ├── dashboard/         # Analytics dashboard
│   │   │   │   ├── sales/             # Sales tracking
│   │   │   │   ├── roles/             # Roles management
│   │   │   │   ├── settings/          # App settings
│   │   │   │   └── store-integration/ # Store integration
│   │   │   └── api/                   # Backend API routes
│   │   ├── components/
│   │   │   ├── atoms/                 # Basic components (Button, Input, etc)
│   │   │   ├── molecules/             # Combined components (Forms, Cards)
│   │   │   └── ui/                    # Radix UI wrapper components
│   │   ├── config/                    # Configurations
│   │   │   ├── Aos.jsx                # Animation on scroll
│   │   │   ├── Notification.js        # Toast notifications
│   │   │   └── Swiper.js              # Carousel setup
│   │   ├── context/
│   │   │   └── ReactQuery.jsx         # React Query setup
│   │   ├── hook/
│   │   │   └── getUser.jsx            # User hook
│   │   ├── i18n/                      # Internationalization
│   │   │   ├── navigation.js          # i18n routing
│   │   │   ├── request.js             # i18n request handler
│   │   │   └── routing.js             # Route configuration
│   │   └── utils/
│   │       ├── api.js                 # Axios instance
│   │       ├── axios.js               # Axios config
│   │       ├── cn.js                  # Tailwind class utils
│   │       └── autoTranslate.js       # Auto translation
│   ├── messages/                      # i18n translations
│   │   ├── en.json
│   │   └── ar.json
│   ├── public/                        # Static assets
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.js
│   ├── tailwind.config.js
│   └── postcss.config.mjs
│
└── README.md                          # This file
```

---

## 📦 Modules

### **1. Authentication Module** (`src/auth/`)

Handles user registration, login, and token management.

**Key Files**:
- `auth.controller.ts` - API endpoints
- `auth.service.ts` - Business logic
- `firebase.service.ts` - Firebase integration
- `jwt.strategy.ts` - JWT passport strategy
- `jwt-auth.guard.ts` - JWT validation guard

**Features**:
- Register with email/password
- Login with email/password
- OTP verification for password reset
- Firebase Admin SDK integration
- JWT token generation (7 days expiry)

**Key Methods**:
```typescript
- register(name, email, password)
- login(email, password)
- verifyOtp(email, otp)
- resetPassword(email)
- validateToken(token)
```

---

### **2. Users Module** (`src/users/`)

Manage user accounts and profiles.

**Entities**:
- `User` - User account with role and plan
- `Role` - Permission groups
- `Permission` - Individual permissions

**Features**:
- Create, read, update, delete users
- Assign roles to users
- User profile management
- Avatar upload support
- Multi-tenancy (admin owns users)

**Data Model**:
```
User {
  id: number
  name: string
  email: string (unique)
  phone?: string
  avatarUrl?: string
  passwordHash?: string
  roleId: number
  role: Role
  planId?: number
  plan?: Plan
  adminId?: number (parent admin for user)
  admin?: User
}

Role {
  id: number
  name: string
  description?: string
  permissionNames: string[]
  adminId?: number (null = global)
  isGlobal: boolean
  users: User[]
}

Permission {
  id: number
  name: string (e.g., 'users.read', 'orders.create')
}
```

---

### **3. Orders Module** (`src/orders/`)

Complete order management system with status tracking and payments.

**Entities**:
- `OrderEntity` - Main order
- `OrderItemEntity` - Line items
- `OrderStatusHistoryEntity` - Status change audit
- `OrderMessageEntity` - Order communication

**Key Enums**:
```typescript
OrderStatus:
- NEW, UNDER_REVIEW, PREPARING, READY, SHIPPED, DELIVERED, CANCELLED, RETURNED

PaymentStatus:
- PENDING, PAID, PARTIAL, REFUNDED

PaymentMethod:
- CASH, CARD, BANK_TRANSFER, COD (Cash on Delivery)
```

**Features**:
- Create orders with line items
- Automatic order number generation (ORD-YYYYMMDD-###)
- Track order status with history
- Support multiple payment methods
- Handle partial payments
- Order shipping management
- Customer messaging

**Order Flow**:
```
NEW → UNDER_REVIEW → PREPARING → READY → SHIPPED → DELIVERED
        ↓
     CANCELLED (at any stage)
     
Payment: PENDING → PARTIAL/PAID → REFUNDED
```

**Key Methods**:
```typescript
- createOrder(createOrderDto)
- getOrders(filters, pagination)
- updateOrder(id, updateOrderDto)
- changeOrderStatus(id, newStatus)
- updatePaymentStatus(id, status)
- addOrderMessage(id, message)
- generateInvoice(id)
```

---

### **4. Products Module** (`src/products/`)

Product and SKU (Stock Keeping Unit) management with variants.

**Entities**:
- `ProductEntity` - Product master data
- `ProductVariantEntity` - SKU variants with attributes

**Features**:
- Create products with multiple SKUs
- Dynamic SKU attributes (size, color, etc.)
- Stock management (on-hand, reserved, available)
- Bulk import/export via Excel
- Product categorization
- Store-specific stock levels
- Price tracking per variant

**Data Model**:
```
Product {
  id: number
  name: string
  description?: string
  categoryId: number
  adminId: string
  status: 'active'|'inactive'
  createdAt: timestamp
  updatedAt: timestamp
}

ProductVariant {
  id: number
  productId: number
  sku: string (unique per admin)
  key: string (canonical attributes hash)
  attributes: { [key]: string } (e.g., {size: 'M', color: 'red'})
  price?: number
  cost?: number
  stockOnHand: number
  reserved: number
  available: number (stockOnHand - reserved)
  adminId: string
}
```

**Key Methods**:
```typescript
- createProduct(createProductDto)
- upsertProductSkus(productId, skus[])
- getProductVariants(productId)
- adjustVariantStock(variantId, adjustment)
- getInventoryReport()
- importProductsFromExcel(file)
- exportProductsToExcel()
```

---

### **5. Orders Module with Purchases** (`src/purchases/`)

Purchase order management from suppliers.

**Entities**:
- `PurchaseEntity` - Purchase orders
- `PurchaseItemEntity` - Line items
- `PurchaseReturnEntity` - Return tracking

**Features**:
- Create POs from suppliers
- Receive goods and update inventory
- Track approval status
- Return management with refund methods
- Financial tracking (due balance)

**Return Methods**:
```
CASH_REFUND, BANK_TRANSFER, SUPPLIER_DEDUCTION
```

---

### **6. Supplier Module** (`src/supplier/`)

Supplier relationship management.

**Entities**:
- `SupplierEntity` - Supplier information
- `SupplierCategoryEntity` - Supplier product categories

**Features**:
- Supplier profiles with contact info
- Financial tracking (due balance, purchase value)
- Category assignments
- Multi-phone support

**Data Model**:
```
Supplier {
  id: number
  name: string
  address?: string
  phone: string
  phoneCountry?: string
  secondPhone?: string
  email?: string
  dueBalance: decimal
  purchaseValue: decimal
  adminId?: string
}
```

---

### **7. Warehouse Module** (`src/warehouse/`)

Inventory warehouse management.

**Features**:
- Create and manage warehouses
- Track stock by warehouse location
- Warehouse-specific stock levels
- Transfer stock between warehouses

---

### **8. Category Module** (`src/category/`)

Product categorization system.

**Features**:
- Create product categories
- Organize products by category
- Multi-tenancy support

---

### **9. Store Module** (`src/stores/`)

Physical store or sales location management.

**Features**:
- Create store profiles
- Store-specific inventory
- Location tracking

---

### **10. Plans Module** (`src/plans/`)

Subscription/billing plans.

**Entities**:
- `PlanEntity` - Subscription plans
- `TransactionEntity` - Payment transactions

**Features**:
- Subscription plan management
- Pricing tiers
- Feature sets per plan
- Transaction history
- Payment tracking

---

### **11. Sales Invoice Module** (`src/sales_invoice/`)

Sales invoice generation and tracking.

**Features**:
- Generate sales invoices from orders
- Invoice numbering
- Financial reporting

---

### **12. Bundles Module** (`src/bundles/`)

Product bundle management (combo offers).

**Features**:
- Create product bundles
- Bundle pricing
- Bundle stock management

---

### **13. Asset Module** (`src/asset/`)

Company asset management.

**Features**:
- Asset inventory
- Asset tracking
- Depreciation management

---

### **14. Permissions & Roles Module** (`src/permissions/`, `src/roles/`)

Role-based access control system.

**Features**:
- Define custom roles
- Assign permissions to roles
- Global vs. admin-specific roles
- Permission guards on endpoints

---

### **15. Lookups Module** (`src/lookups/`)

Reference/lookup data.

**Features**:
- Dropdown data
- Reference information
- Static data retrieval

---

### **16. Transactions Module** (`src/transactions/`)

Financial transaction tracking.

**Features**:
- Record transactions
- Payment history
- Financial reporting

---

## 🔐 Authentication & Authorization

### **Authentication Flow**

```
1. User Registration/Login
   ├── Email + Password → validate
   ├── Generate JWT token (7 days)
   └── Return {accessToken, user {id, name, email, role, plan}}

2. JWT Token Structure
   ├── sub: user.id
   ├── iat: issued at
   └── exp: expiration (7 days)

3. Firebase Integration (optional)
   ├── Firebase Admin SDK
   ├── Custom claims
   └── Email verification
```

### **Authorization (RBAC)**

**Three Role Levels**:

1. **Super Admin** (`super_admin`)
   - Full system access
   - Can create other admins
   - Manage all data across all tenants
   - Access to all permissions

2. **Admin** (`admin`)
   - Own data isolation
   - Can create users and assign roles
   - Manage products, orders, suppliers, etc.
   - Cannot access other admins' data

3. **User** (`user`)
   - Limited permissions
   - Assigned by admin
   - Can view/manage assigned resources

**Permission System**:

```typescript
// Example permissions
'users.read'
'users.create'
'users.update'
'users.delete'
'orders.read'
'orders.create'
'orders.update'
'products.read'
'products.create'
'products.update'
'suppliers.read'
// ... many more
```

**Guard Implementation**:

```typescript
// src/common/permissions.guard.ts
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('orders.read', 'orders.create')
async createOrder(@Body() dto: CreateOrderDto) {
  // Only users with these permissions can access
}
```

**Multi-tenancy**:

```typescript
// Extract tenant ID from request
function tenantId(user) {
  if (user.role.name === 'super_admin') return null;  // all data
  if (user.role.name === 'admin') return user.id;     // own data
  return user.adminId;                                 // parent admin's data
}

// All queries filtered by tenantId
await this.orderRepo.find({ where: { adminId: tenantId(me) } })
```

---

## 🗄️ Database Schema

### **Core Entities**

#### Users & Security
- `users` - User accounts
- `roles` - Role definitions
- `permissions` - Permission definitions

#### Orders & Sales
- `orders` - Sales orders
- `order_items` - Order line items
- `order_status_history` - Order status audit log
- `order_messages` - Order communication
- `sales_invoices` - Generated invoices

#### Products & Inventory
- `products` - Product master data
- `product_variants` - SKUs with attributes and pricing
- `categories` - Product categories
- `stores` - Sales locations
- `warehouses` - Inventory locations

#### Purchasing
- `purchases` - Purchase orders
- `purchase_items` - PO line items
- `purchase_returns` - Return tracking
- `suppliers` - Supplier information
- `supplier_categories` - Supplier product categories

#### Billing & Plans
- `plans` - Subscription plans
- `transactions` - Payment transactions

#### Other
- `assets` - Company assets
- `bundles` - Product bundles

### **Key Relationships**

```
User → Role (ManyToOne)
User → Plan (ManyToOne)
User → User (self, parent admin)

Order → OrderItem (OneToMany)
Order → OrderStatusHistory (OneToMany)
Order → OrderMessage (OneToMany)

Product → ProductVariant (OneToMany)
Product → Category (ManyToOne)

Supplier → SupplierCategory (ManyToMany)

Purchase → PurchaseItem (OneToMany)
Purchase → PurchaseReturn (OneToMany)

Plan → Transaction (OneToMany)
```

---

## ✨ Key Features

### **Order Management**
✅ Create and manage customer orders  
✅ Real-time order status tracking  
✅ Payment processing (COD, card, bank transfer)  
✅ Order history and audit logs  
✅ Customer messaging  
✅ Invoice generation  

### **Inventory Management**
✅ Product and SKU management  
✅ Dynamic product variants  
✅ Stock level tracking  
✅ Reserved stock management  
✅ Warehouse-based inventory  
✅ Stock transfer between locations  

### **Supplier Management**
✅ Supplier profiles  
✅ Purchase order creation  
✅ Goods receipt and stock update  
✅ Return management  
✅ Financial tracking (due balance)  

### **Multi-tenancy**
✅ Complete data isolation between admins  
✅ Admin can have multiple users  
✅ Hierarchical permission system  
✅ Super admin oversight  

### **Internationalization (i18n)**
✅ Arabic & English support  
✅ RTL/LTR layout support  
✅ Dynamic language switching  
✅ Translated UI components  

### **User Experience**
✅ Responsive design (Tailwind CSS)  
✅ Smooth animations (Framer Motion, GSAP)  
✅ Data tables with sorting/filtering  
✅ Form validation (client & server)  
✅ Toast notifications  
✅ Loading states  

### **Backend Features**
✅ Automatic error handling  
✅ Data validation (DTO-based)  
✅ Email notifications (Gmail)  
✅ File uploads (images with compression)  
✅ Excel import/export  
✅ Pagination & filtering  

---

## 🚀 Getting Started

### **Prerequisites**
- Node.js 18+ 
- PostgreSQL 12+
- Firebase account (for authentication)
- Gmail account (for email service)

### **Backend Setup**

```bash
# Install dependencies
cd order-managment-system-backend
npm install

# Setup environment variables
cp .env.example .env
# Edit .env with your database and Firebase credentials

# Run migrations
npm run migration:run

# Seed initial data
npm run seed

# Start development server
npm run start:dev

# Build for production
npm run build
npm run start:prod
```

### **Frontend Setup**

```bash
# Install dependencies
cd order-managment-system-frontend
npm install

# Setup environment variables
cp .env.example .env.local
# Add NEXT_PUBLIC_BASE_URL pointing to backend API

# Start development server
npm run dev

# Build for production
npm run build
npm run start
```

### **Environment Variables**

**Backend (.env)**:
```env
PORT=3030
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=password
DATABASE_NAME=orders_db
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=7d
EMAIL_USER=your@gmail.com
EMAIL_PASS=app_password
FIREBASE_PROJECT_ID=your_project
FIREBASE_CLIENT_EMAIL=your_email
FIREBASE_PRIVATE_KEY=your_key
```

**Frontend (.env.local)**:
```env
NEXT_PUBLIC_BASE_URL=http://localhost:3030
```

---

## 📡 API Endpoints

### **Authentication**
```
POST   /auth/register          - Register new user
POST   /auth/login             - Login user
POST   /auth/verify-otp        - Verify OTP
POST   /auth/reset-password    - Reset password
```

### **Users**
```
GET    /users                  - Get users list
POST   /users                  - Create user
GET    /users/:id              - Get user by ID
PATCH  /users/:id              - Update user
DELETE /users/:id              - Delete user
```

### **Orders**
```
GET    /orders                 - Get orders
POST   /orders                 - Create order
GET    /orders/:id             - Get order details
PATCH  /orders/:id             - Update order
PATCH  /orders/:id/status      - Change order status
PATCH  /orders/:id/payment     - Update payment status
POST   /orders/:id/messages    - Add order message
POST   /orders/:id/invoice     - Generate invoice
```

### **Products**
```
GET    /products               - Get products
POST   /products               - Create product
GET    /products/:id           - Get product details
PATCH  /products/:id           - Update product
DELETE /products/:id           - Delete product
POST   /products/:id/skus      - Upsert SKUs
GET    /products/:id/skus      - Get product variants
PATCH  /products/variants/:id  - Adjust stock
```

### **Suppliers**
```
GET    /suppliers              - Get suppliers
POST   /suppliers              - Create supplier
GET    /suppliers/:id          - Get supplier
PATCH  /suppliers/:id          - Update supplier
DELETE /suppliers/:id          - Delete supplier
```

### **Purchases**
```
GET    /purchases              - Get purchase orders
POST   /purchases              - Create PO
GET    /purchases/:id          - Get PO details
PATCH  /purchases/:id          - Update PO
POST   /purchases/:id/receive  - Receive goods
```

### **And many more...**

See `postman.json` for complete API documentation.

---

## 👥 User Roles & Permissions

### **Super Admin**
- System administrator
- Can manage all users, roles, and permissions
- Access to all data
- Can create other admins

### **Admin**
- Business owner/manager
- Creates and manages users under them
- Full control over products, orders, suppliers, etc.
- Data isolation (only sees their data)
- Can define custom roles

### **User**
- Employee/staff member
- Limited to assigned permissions
- Cannot create other users
- Can create orders, view products, etc. based on role

---

## 📊 Data Flow

### **Order Creation Flow**

```
Frontend (Create Order Form)
    ↓
POST /orders + OrderDto
    ↓
Backend Validation (DTO, inventory, permissions)
    ↓
Generate unique order number
    ↓
Create Order + OrderItems
    ↓
Reserve inventory (ProductVariant.reserved += qty)
    ↓
Create initial OrderStatusHistory (NEW)
    ↓
Send email notification
    ↓
Return Order object
    ↓
Frontend updates UI
```

### **Order Status Workflow**

```
Customer Action          Admin Action          System Action
     ↓                        ↓                       ↓
     Place Order          Review Order         Validate Payment
         ↓                    ↓                       ↓
     Payment              Approve/Reject        Update Status
         ↓                    ↓                       ↓
  Confirm Order         Prepare Goods         Create Audit Log
         ↓                    ↓                       ↓
  Wait for Ship       Mark Ready to Ship      Send Notification
         ↓                    ↓                       ↓
   Track Status         Ship Order            Update Status + Track
         ↓                    ↓                       ↓
   Receive Order    Delivery Confirmation    Final Status
```

### **Product Inventory Flow**

```
Add Product
    ↓
Define Variants (SKUs)
    ↓
Set Stock Levels
    ↓
Create Purchase Order
    ↓
Receive Goods
    ↓
Update Inventory (stockOnHand)
    ↓
Create Sales Order
    ↓
Reserve Stock (reserved += qty)
    ↓
Ship Order
    ↓
Confirm Delivery
    ↓
Clear Reserved Stock
    ↓
Update Available = stockOnHand - reserved
```

### **Authentication & Access Control Flow**

```
User Visits App
    ↓
Redirect to Login (if no token)
    ↓
Enter Email + Password
    ↓
POST /auth/login
    ↓
Validate credentials (bcryptjs)
    ↓
Generate JWT token
    ↓
Return token + user info
    ↓
Store token in localStorage
    ↓
API interceptor adds "Authorization: Bearer {token}" to all requests
    ↓
Backend validates JWT
    ↓
Extract user ID from token
    ↓
Check permissions for endpoint
    ↓
Filter data by tenantId (adminId)
    ↓
Return authorized data
```

---

## 🔧 Development Tips

### **Running Tests**
```bash
# Backend tests
cd order-managment-system-backend
npm run test              # Run tests once
npm run test:watch       # Watch mode
npm run test:cov         # Coverage report

# Frontend linting
cd order-managment-system-frontend
npm run lint
```

### **Database Migrations**
```bash
# Generate migration from entities
npm run migration:generate -- -n "FeatureName"

# Run pending migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

### **Code Formatting**
```bash
# Backend
npm run format
npm run lint

# Frontend
npm run lint
```

### **Building for Production**

**Backend**:
```bash
npm run build
npm run start:prod

# Or with PM2
pm2 start dist/main.js
```

**Frontend**:
```bash
npm run build
npm run start
```

---

## 📝 Notes

- **Multi-tenancy**: Always filter queries by `adminId`
- **Permissions**: Use `@Permissions()` decorator on protected routes
- **File uploads**: Stored in `/uploads` directory, served as static files
- **Email**: Uses Gmail with app passwords (not account password)
- **JWT**: Expires in 7 days, refresh token needed for longer sessions
- **Database**: PostgreSQL with automatic synchronization enabled
- **Internationalization**: Use `next-intl` on frontend, backend returns English text
- **Validation**: Always validate DTOs using class-validator

---

## 🤝 Contributing

1. Follow the existing code structure
2. Use TypeScript for type safety
3. Add DTOs for API endpoints
4. Include permission checks for protected routes
5. Write tests for critical business logic
6. Document complex functions

---

## 📄 License

UNLICENSED (Private Project)

---

## 👨‍💻 Support

For issues or questions about the project structure, refer to:
- API Documentation: See `postman.json`
- Database Entities: Check `entities/` directory
- Service Logic: Review service files in each module
- DTOs: Review `dto/` directory for request/response models

---

**Last Updated**: January 2026
