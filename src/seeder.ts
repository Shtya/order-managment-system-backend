import 'dotenv/config';
import { DataSource } from 'typeorm';

import { User, Role, Permission } from '../entities/user.entity';
import { Asset } from '../entities/assets.entity';
import { CategoryEntity } from '../entities/categories.entity';
import { StoreEntity } from '../entities/stores.entity';
import { WarehouseEntity } from '../entities/warehouses.entity';
import { Plan, Transaction } from '../entities/plans.entity';
import { OrderEntity, OrderItemEntity, OrderMessageEntity, OrderStatus, OrderStatusEntity, OrderStatusHistoryEntity } from '../entities/order.entity';
import { BundleEntity, BundleItemEntity } from '../entities/bundle.entity';
import { PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity } from '../entities/purchase_return.entity';
import { PurchaseInvoiceEntity, PurchaseInvoiceItemEntity } from '../entities/purchase.entity';
import { SalesInvoiceEntity, SalesInvoiceItemEntity } from '../entities/sales_invoice.entity';
import { ProductEntity, ProductVariantEntity } from '../entities/sku.entity';
import { SupplierEntity, SupplierCategoryEntity } from '../entities/supplier.entity';

/**
 * =========================
 * DataSource CONFIG
 * =========================
 */
const dataSource = new DataSource({
	type: 'postgres',
	host: process.env.DATABASE_HOST,
	port: Number(process.env.DATABASE_PORT),
	username: process.env.DATABASE_USER,
	password: process.env.DATABASE_PASSWORD,
	database: process.env.DATABASE_NAME,

	// ⚠️ لازم كل الـ entities
	entities: [User, Role, Permission, SupplierEntity, SupplierCategoryEntity, BundleEntity, SalesInvoiceItemEntity, ProductEntity, ProductVariantEntity, SalesInvoiceEntity, PurchaseInvoiceItemEntity, PurchaseReturnInvoiceItemEntity, PurchaseInvoiceEntity, PurchaseReturnInvoiceEntity, BundleItemEntity, Asset, Plan, Transaction, CategoryEntity, StoreEntity, WarehouseEntity, OrderEntity, OrderStatusEntity, OrderItemEntity,
		OrderStatusHistoryEntity,
		OrderMessageEntity,
	],

	synchronize: true, // فقط dev
});

/**
 * =========================
 * Seeder Logic
 * =========================
 */
async function runGlobalSeed() {
	console.log('🌱 Running global seeders...');

	const categoryRepo = dataSource.getRepository(CategoryEntity);
	const storeRepo = dataSource.getRepository(StoreEntity);
	const warehouseRepo = dataSource.getRepository(WarehouseEntity);
	const statusRepo = dataSource.getRepository(OrderStatusEntity); // Add this
	const systemStatuses = [
		{
			name: 'New',
			code: OrderStatus.NEW,
			color: '#2196F3', // Matches stats.new (Blue)
			isDefault: true,
			order: 1
		},
		{
			name: 'Under Review',
			code: OrderStatus.UNDER_REVIEW,
			color: '#FF9800', // Matches stats.pendingConfirmation (Orange)
			isDefault: false,
			order: 2
		},
		{
			name: 'Preparing',
			code: OrderStatus.PREPARING,
			color: '#9C27B0', // Matches stats.total/processing (Purple)
			isDefault: false,
			order: 3
		},
		{
			name: 'Ready',
			code: OrderStatus.READY,
			color: '#009688', // Matches stats.postponed/teal (Teal/Ready)
			isDefault: false,
			order: 4
		},
		{
			name: 'Shipped',
			code: OrderStatus.SHIPPED,
			color: '#03A9F4', // Matches stats.inShipping (Light Blue)
			isDefault: false,
			order: 5
		},
		{
			name: 'Delivered',
			code: OrderStatus.DELIVERED,
			color: '#4CAF50', // Matches stats.delivered (Green)
			isDefault: false,
			order: 6
		},
		{
			name: 'Cancelled',
			code: OrderStatus.CANCELLED,
			color: '#F44336', // Matches stats.cancelledShipping (Red)
			isDefault: false,
			order: 7
		},
		{
			name: 'Returned',
			code: OrderStatus.RETURNED,
			color: '#607D8B', // Grey (Standard for Returned/Archive)
			isDefault: false,
			order: 8
		},
	];

	for (const s of systemStatuses) {
		// [2025-12-24] Trim duplicates by checking name and isSystem
		const exists = await statusRepo.findOne({
			where: { name: s.name, system: true },
		});

		if (!exists) {
			await statusRepo.save(
				statusRepo.create({
					name: s.name,
					code: s.code,
					color: s.color,
					isDefault: s.isDefault,
					system: true,
					adminId: null, // Global
					sortOrder: s.order,
					description: `System default status for ${s.name}`,
				}),
			);
		}
	}

	/** =========================
	 * Global Categories
	 * ========================= */
	const categories = [{ name: 'عام' }, { name: 'إلكترونيات' }, { name: 'ملابس' }, { name: 'أغذية' }, { name: 'مستلزمات منزلية' }];

	for (const c of categories) {
		const exists = await categoryRepo.findOne({
			where: { name: c.name, adminId: null },
		});

		if (!exists) {
			await categoryRepo.save(
				categoryRepo.create({
					adminId: null,
					name: c.name,
					image: null,
				}),
			);
		}
	}

	/** =========================
	 * Global Stores
	 * ========================= */
	const stores = [
		{ name: 'المتجر الرئيسي', code: 'MAIN' },
		{ name: 'متجر التجزئة', code: 'RETAIL' },
	];

	for (const s of stores) {
		const exists = await storeRepo.findOne({
			where: { code: s.code, adminId: null },
		});

		if (!exists) {
			await storeRepo.save(
				storeRepo.create({
					adminId: null,
					name: s.name,
					code: s.code,
					isActive: true,
				}),
			);
		}
	}

	/** =========================
	 * Global Warehouses
	 * ========================= */
	const warehouses = [
		{
			name: 'المخزن الرئيسي',
			location: 'القاهرة',
		},
		{
			name: 'مخزن الطوارئ',
			location: 'الجيزة',
		},
	];

	for (const w of warehouses) {
		const exists = await warehouseRepo.findOne({
			where: { name: w.name, adminId: null },
		});

		if (!exists) {
			await warehouseRepo.save(
				warehouseRepo.create({
					adminId: null,
					name: w.name,
					location: w.location,
					manager: null,
					phone: null,
					isActive: true,
				}),
			);
		}
	}

	console.log('✅ Global seed completed');
}

dataSource
	.initialize()
	.then(async () => {
		await runGlobalSeed();
		await dataSource.destroy();
		process.exit(0);
	})
	.catch(err => {
		console.error('❌ Seeder failed', err);
		process.exit(1);
	});
