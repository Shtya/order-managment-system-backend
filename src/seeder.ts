import 'dotenv/config';
import { DataSource } from 'typeorm';

import { User, Role, Permission } from '../entities/user.entity';
import { CategoryEntity } from '../entities/categories.entity';
import { StoreEntity } from '../entities/stores.entity';
import { WarehouseEntity } from '../entities/warehouses.entity';
import { Plan, Transaction } from '../entities/plans.entity';

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
	entities: [User, Role, Permission, Plan, Transaction, CategoryEntity, StoreEntity, WarehouseEntity],

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
