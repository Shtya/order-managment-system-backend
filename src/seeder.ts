import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, In, Repository } from 'typeorm';

import { CategoryEntity } from '../entities/categories.entity';
import typeDataSource from '../typeorm.config';
import { WarehouseEntity } from '../entities/warehouses.entity';
import { OrderStatus, OrderStatusEntity } from '../entities/order.entity';
import { AreaEntity, CityEntity, ProviderLocationEntity } from 'entities/cities.entity';
import { Role, SystemRole, User } from 'entities/user.entity';
import {
	GettingStartedAchievementType,
	GettingStartedItemEntity,
	GettingStartedStepEntity,
} from 'entities/getting-started.entity';

/**
 * =========================
 * DataSource CONFIG
 * =========================
 */
const dataSource = typeDataSource;
function generateSecurePassword(length = 16) {
	const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const lower = 'abcdefghijklmnopqrstuvwxyz';
	const numbers = '0123456789';
	const symbols = '!@#$%^&*()-_=+[]{}';
	const pool = upper + lower + numbers + symbols;

	const pick = (set: string) => set[crypto.randomInt(0, set.length)];
	const password = [pick(upper), pick(lower), pick(numbers), pick(symbols)];

	while (password.length < length) {
		password.push(pick(pool));
	}

	for (let index = password.length - 1; index > 0; index -= 1) {
		const swapIndex = crypto.randomInt(0, index + 1);
		[password[index], password[swapIndex]] = [password[swapIndex], password[index]];
	}

	return password.join('');
}

function parseSimpleCsv(filePath: string) {
	const content = fs.readFileSync(filePath, 'utf8');
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.split(',').map((column) => column.trim()));
}

function parseBoolean(value: string | boolean | undefined | null) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return ['true', 't', '1', 'yes', 'y'].includes(normalized);
}

async function seedCitiesFromCsv(cityRepo: Repository<CityEntity>) {
	const csvPath = path.resolve(__dirname, '../cities.csv');
	if (!fs.existsSync(csvPath)) {
		console.log('⚠️ cities.csv not found, skipping city seeding');
		return new Map<string, CityEntity>();
	}

	const rows = parseSimpleCsv(csvPath).filter((columns) => columns.length >= 3);
	const cityRows = rows.map(([id, nameEn, nameAr, isActive]) => ({
		id: id || undefined,
		nameEn: nameEn || '',
		nameAr: nameAr || '',
		isActive: parseBoolean(isActive),
	}));

	const existingCities = await cityRepo.find();
	const existingById = new Map(existingCities.filter((city) => city.id).map((city) => [city.id, city]));
	const existingByNameEn = new Map(existingCities.filter((city) => city.nameEn).map((city) => [city.nameEn.toLowerCase(), city]));

	const citiesToSave: CityEntity[] = [];
	for (const row of cityRows) {
		if (!row.id || !row.nameEn || !row.nameAr) {
			continue;
		}

		const existingCity = existingById.get(row.id) || existingByNameEn.get(row.nameEn.toLowerCase());
		const cityEntity = existingCity ? existingCity : cityRepo.create();
		cityEntity.id = row.id;
		cityEntity.nameEn = row.nameEn;
		cityEntity.nameAr = row.nameAr;
		cityEntity.isActive = row.isActive;
		citiesToSave.push(cityEntity);
	}

	if (citiesToSave.length > 0) {
		await cityRepo.save(citiesToSave);
	}

	return new Map(citiesToSave.map((city) => [city.id, city]));
}

async function seedProviderLocationsFromCsv(providerLocationRepo: Repository<ProviderLocationEntity>, cityRepo: Repository<CityEntity>) {
	const csvPath = path.resolve(__dirname, '../cities-provider.csv');
	if (!fs.existsSync(csvPath)) {
		console.log('⚠️ cities-provider.csv not found, skipping provider location seeding');
		return;
	}

	const rows = parseSimpleCsv(csvPath).filter((columns) => columns.length >= 6);
	const existingProviderLocations = await providerLocationRepo.find();
	const existingKeyMap = new Map(existingProviderLocations.map((location) => [`${location.provider}:${location.providerCityId}`, location]));
	const cityMap = new Map((await cityRepo.find()).map((city) => [city.id, city]));

	const locationsToSave: ProviderLocationEntity[] = [];
	for (const columns of rows) {
		const [id, providerCityId, providerCityNameAr, providerCityNameEn, cityId, provider, dropOff, pickup] = columns;
		if (!providerCityId || !provider || !cityId) {
			continue;
		}

		const existingLocation = existingKeyMap.get(`${provider}:${providerCityId}`);
		const locationEntity = existingLocation ? existingLocation : providerLocationRepo.create();
		locationEntity.id = id || locationEntity.id;
		locationEntity.provider = provider as any;
		locationEntity.providerCityId = providerCityId;
		locationEntity.providerCityNameAr = providerCityNameAr || providerCityId;
		locationEntity.providerCityNameEn = providerCityNameEn || providerCityNameAr || providerCityId;
		locationEntity.cityId = cityMap.has(cityId) ? cityId : null;
		locationEntity.city = cityMap.get(cityId) || null;
		locationEntity.dropOff = parseBoolean(dropOff);
		locationEntity.pickup = parseBoolean(pickup);
		locationsToSave.push(locationEntity);
	}

	if (locationsToSave.length > 0) {
		await providerLocationRepo.save(locationsToSave);
	}
}

async function seedAreasFromCsv(areaRepo: Repository<AreaEntity>, cityMap: Map<string, CityEntity>) {
	const csvPath = path.resolve(__dirname, '../areas.csv');
	if (!fs.existsSync(csvPath)) {
		console.log('⚠️ areas.csv not found, skipping area seeding');
		return;
	}

	const rows = parseSimpleCsv(csvPath).filter((columns) => columns.length >= 3);
	const areaRows = rows.map((columns) => {
		const [id, nameEn, nameAr, , cityId] = columns;
		return {
			id: id || undefined,
			nameEn: nameEn || '',
			nameAr: nameAr || '',
			cityId: cityId || null,
		};
	});

	const existingAreas = await areaRepo.find();
	const existingById = new Map(existingAreas.filter((area) => area.id).map((area) => [area.id, area]));
	const areasToSave: AreaEntity[] = [];
	for (const row of areaRows) {
		if (!row.id || !row.nameEn || !row.nameAr) {
			continue;
		}

		if (!row.cityId || !cityMap.has(row.cityId)) {
			console.log(`⚠️ Skipping area ${row.nameEn} without a seeded city id (${row.cityId || 'missing'})`);
			continue;
		}

		const existingArea = existingById.get(row.id);
		const areaEntity = existingArea ? existingArea : areaRepo.create();
		areaEntity.id = row.id;
		areaEntity.nameEn = row.nameEn;
		areaEntity.nameAr = row.nameAr;
		areaEntity.cityId = row.cityId;
		areaEntity.isActive = true;
		areasToSave.push(areaEntity);
	}

	if (areasToSave.length > 0) {
		await areaRepo.save(areasToSave);
	}
}

async function seedSuperAdminUser(roleRepo: Repository<Role>, userRepo: Repository<User>) {
	const email = 'superadmin@gmail.com';
	const normalizedEmail = email.trim().toLowerCase();
	const name = 'super admin';
	// const password = generateSecurePassword();
	const password = "superA12#*89";
	const passwordHash = await bcrypt.hash(password, 12);

	let role = await roleRepo.findOne({ where: { name: SystemRole.SUPER_ADMIN } });
	if (!role) {
		role = await roleRepo.save(
			roleRepo.create({
				name: SystemRole.SUPER_ADMIN,
				description: 'Owner of the system (full access)',
				permissionNames: ['*'],
				adminId: null,
				isGlobal: true,
			}),
		);
	}

	const existingUser = await userRepo.findOne({ where: { email: normalizedEmail } });
	const userPayload = {
		name,
		email: normalizedEmail,
		passwordHash,
		roleId: role.id,
		adminId: null,
		isActive: true,
		otpVerified: true,
		otpCodeHash: null,
		otpExpiresAt: null,
		otpAttempts: 0,
	};

	if (existingUser) {
		await userRepo.save({
			...existingUser,
			...userPayload,
		});
	} else {
		await userRepo.save(userRepo.create(userPayload));
	}

	console.log(`✅ Super admin user seeded: ${normalizedEmail}`);
	console.log(`🔐 Generated password: ${password}`);
}

/**
 * =========================
 * Individual Seed Sections
 * =========================
 */

async function seedOrderStatuses() {
	const statusRepo = dataSource.getRepository(OrderStatusEntity);

	const systemStatuses = [
		{
			name: 'New', code: OrderStatus.NEW, isDefault: true, order: 1, color: '#2196F3', // Matches stats.new (Blue)
		},
		{
			name: 'Under Review', code: OrderStatus.UNDER_REVIEW, isDefault: false, order: 2, color: '#FF9800', // Matches stats.pendingConfirmation (Orange)
		},
		{
			name: 'PostPoned', code: OrderStatus.POSTPONED, isDefault: false, order: 3, color: '#00BCD4', // سماوي
		},
		{
			name: 'Confirmed', code: OrderStatus.CONFIRMED, isDefault: false, order: 4, color: '#4CAF50', // أخضر (نجاح التأكيد)
		},
		{
			name: 'No Answer', code: OrderStatus.NO_ANSWER, isDefault: false, order: 5, color: '#FF5722', // برتقالي محروق (تحذير)
		},
		{
			name: 'No Answer - Follow Up', code: OrderStatus.NO_ANSWER_FOLLOW_UP, isDefault: false, order: 6, color: '#FF5722', // Same as No Answer
		},
		{
			name: 'Wrong Number', code: OrderStatus.WRONG_NUMBER, isDefault: false, order: 7, color: '#795548', // بني
		},
		{
			name: 'Out of Delivery Area', code: OrderStatus.OUT_OF_DELIVERY_AREA, isDefault: false, order: 8, color: '#673AB7', // بنفسجي غامق
		},
		{
			name: 'Duplicate', code: OrderStatus.DUPLICATE, isDefault: false, order: 9, color: '#E91E63', // وردي (تنبيه تكرار)
		},
		{
			name: 'Rejected', code: OrderStatus.REJECTED, isDefault: false, order: 10, color: '#F44336', // Red (Matches stats.cancelledShipping)
		},
		{
			name: 'Cancelled', code: OrderStatus.CANCELLED, isDefault: false, order: 11, color: '#F44336', // Matches stats.cancelledShipping (Red)
		},
		{
			name: 'Cancelled - Follow Up', code: OrderStatus.CANCELLED_FOLLOW_UP, isDefault: false, order: 12, color: '#F44336', // Same as Cancelled
		},
		{
			name: 'Failed Delivery', code: OrderStatus.FAILED_DELIVERY, isDefault: false, order: 13, color: '#E91E63', // Pink (Alert for delivery issues)
		},
		{
			name: 'Distributed', code: OrderStatus.DISTRIBUTED, isDefault: false, order: 14, color: '#9C27B0', // Purple (Indicates it's out for handling)
		},
		{ name: 'Printed', code: OrderStatus.PRINTED, isDefault: false, order: 15, color: '#3F51B5', },
		{
			name: 'Preparing', code: OrderStatus.PREPARING, isDefault: false, order: 16, color: '#9C27B0', // Matches stats.total/processing (Purple)
		},
		{
			name: 'Ready', code: OrderStatus.READY, isDefault: false, order: 17, color: '#009688', // Matches stats.postponed/teal (Teal/Ready)
		},
		{
			name: 'Shipped', code: OrderStatus.SHIPPED, isDefault: false, order: 19, color: '#03A9F4', // Matches stats.inShipping (Light Blue)
		},
		{
			name: 'Delivered', code: OrderStatus.DELIVERED, isDefault: false, order: 20, color: '#4CAF50', // Matches stats.delivered (Green)
		},
		{
			name: 'Return Preparing',
			code: OrderStatus.RETURN_PREPARING,
			isDefault: false,
			order: 21,
			color: '#FF9800', // Orange (Matches "Under Review" style)
		},
		{
			name: 'Returned', code: OrderStatus.RETURNED, isDefault: false, order: 22, color: '#607D8B', // Grey (Standard for Returned/Archive)
		},
		{
			name: 'Partially Returned',
			code: OrderStatus.PARTIALLY_RETURNED,
			isDefault: false,
			order: 23,
			color: '#795548', // Brown (Distinct from Returned's grey and Delivered's green)
		},
	];

	for (const s of systemStatuses) {
		const exists = await statusRepo.findOne({
			where: { code: s.code, adminId: null },
		});

		const statusData = {
			name: s.name,
			code: s.code,
			color: s.color,
			isDefault: s.isDefault,
			system: true,
			adminId: null,
			sortOrder: s.order,
			description: `System default status for ${s.name}`,
		};

		if (exists) {
			await statusRepo.save({
				...exists,
				...statusData,
			});
		} else {
			await statusRepo.save(statusRepo.create(statusData));
		}
	}
}

async function seedLocations() {
	console.log('🌱 Seeding locations (cities, provider locations, areas)...');

	const cityRepo = dataSource.getRepository(CityEntity);
	const areaRepo = dataSource.getRepository(AreaEntity);
	const providerLocationRepo = dataSource.getRepository(ProviderLocationEntity);

	// 1. Seed Unified Cities from CSV
	const seededCities = await seedCitiesFromCsv(cityRepo);
	console.log(`✅ Seeded ${seededCities.size} cities from cities.csv`);

	// 2. Seed Provider Locations from CSV
	await seedProviderLocationsFromCsv(providerLocationRepo, cityRepo);

	// 3. Seed Areas from CSV
	await seedAreasFromCsv(areaRepo, seededCities);
}

async function seedSuperAdmin() {
	console.log('🌱 Seeding super admin...');

	const roleRepo = dataSource.getRepository(Role);
	const userRepo = dataSource.getRepository(User);

	await seedSuperAdminUser(roleRepo, userRepo);
}

async function seedCategories() {
	console.log('🌱 Seeding global categories...');

	const categoryRepo = dataSource.getRepository(CategoryEntity);

	/** =========================
	 * Global Categories
	 * ========================= */
	const categories = [
		{
			name: 'عام',
			slug: 'aam',
			image: null,
			adminId: null,
		},
		{
			name: 'إلكترونيات',
			slug: 'electronics',
			image: null,
			adminId: null,
		},
		{
			name: 'ملابس',
			slug: 'clothing',
			image: null,
			adminId: null,
		},
		{
			name: 'أغذية',
			slug: 'food',
			image: null,
			adminId: null,
		},
		{
			name: 'مستلزمات منزلية',
			slug: 'home-supplies',
			image: null,
			adminId: null,
		},
	];
	for (const c of categories) {
		const exists = await categoryRepo.findOne({
			where: { name: c.name, adminId: null },
		});

		if (!exists) {
			await categoryRepo.save(
				categoryRepo.create({
					adminId: null,
					name: c.name,
					slug: c.slug, // IMPORTANT
					image: c.image ?? null,
				}),
			);
		}
	}
}

async function seedWarehouses() {
	console.log('🌱 Seeding global warehouses...');

	const warehouseRepo = dataSource.getRepository(WarehouseEntity);

	/** =========================
	 * Global Warehouses
	 * ========================= */
	const warehouses = [
		{
			name: 'المخزن الرئيسي',
			address: null,
			description: null,
			isActive: true,
		},
		{
			name: 'مخزن الطوارئ',
			address: null,
			description: null,
			isActive: true,
		},
	];

	for (const w of warehouses) {
		const exists = await warehouseRepo.findOne({
			where: {
				name: w.name,
				adminId: null,
			},
		});

		if (!exists) {
			await warehouseRepo.save(
				warehouseRepo.create({
					adminId: null,
					name: w.name,
					address: w.address ?? null,
					description: w.description ?? null,
					isActive: true,
				}),
			);
		}
	}
}

/**
 * =========================
 * Getting Started / Checklist Seed
 * =========================
 */

interface GettingStartedChecklistStep {
	key: string;
	title: { ar: string; en: string };
	description: { ar: string; en: string };
	target: { type: string; page: string; key: string };
	sortOrder: number;
}

interface GettingStartedChecklistItem {
	key: string;
	title: { ar: string; en: string };
	description: { ar: string; en: string };
	completionType: GettingStartedAchievementType;
	dependsOn: string[];
	sortOrder: number;
	steps: GettingStartedChecklistStep[];
}

const gettingStartedChecklist: GettingStartedChecklistItem[] = [
	{
		key: 'add_first_warehouse',
		title: { ar: 'أنشئ أول مخزن', en: 'Create your first warehouse' },
		description: { ar: 'المخازن تحتفظ بمخزونك وهي أساس تجهيز الطلبات.', en: 'Warehouses hold your stock and are the base of order fulfilment.' },
		completionType: GettingStartedAchievementType.FIRST_WAREHOUSE_CREATED,
		dependsOn: [],
		sortOrder: 1,
		steps: [
			{
				key: 'open_warehouses_page',
				title: { ar: 'افتح صفحة المخازن', en: 'Open the Warehouses page' },
				description: { ar: 'انتقل إلى صفحة المخازن من القائمة الجانبية.', en: 'Navigate to Warehouses from the sidebar.' },
				target: { type: 'route', page: '/warehouses', key: 'warehouses' },
				sortOrder: 1,
			},
			{
				key: 'create_warehouse',
				title: { ar: 'أنشئ مخزنًا', en: 'Create a warehouse' },
				description: { ar: 'اضغط زر إضافة مخزن واملأ البيانات المطلوبة.', en: 'Click "Add Warehouse" and fill in the required details.' },
				target: { type: 'element', page: '/warehouses', key: 'add-warehouse-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'add_first_product',
		title: { ar: 'أنشئ أول منتج', en: 'Create your first product' },
		description: { ar: 'المنتجات هي العناصر التي تبيعها. أضف منتجًا مع وحدات SKU الخاصة به.', en: 'Products are the items you sell. Add one with its variants and SKUs.' },
		completionType: GettingStartedAchievementType.FIRST_PRODUCT_CREATED,
		dependsOn: [],
		sortOrder: 2,
		steps: [
			{
				key: 'open_products_page',
				title: { ar: 'افتح صفحة المنتجات', en: 'Open the Products page' },
				description: { ar: 'انتقل إلى صفحة المنتجات من القائمة الجانبية.', en: 'Navigate to Products from the sidebar.' },
				target: { type: 'route', page: '/products', key: 'products' },
				sortOrder: 1,
			},
			{
				key: 'create_product',
				title: { ar: 'أنشئ منتجًا', en: 'Create a product' },
				description: { ar: 'اضغط زر إضافة منتج واملأ البيانات الأساسية.', en: 'Click "Add Product" and fill in the basic details.' },
				target: { type: 'element', page: '/products', key: 'add-product-button' },
				sortOrder: 2,
			},
			{
				key: 'add_variant_and_sku',
				title: { ar: 'أضف فرعًا ورمز SKU', en: 'Add a variant and SKU' },
				description: { ar: 'أضف فرعًا للمنتج وحدد رمز SKU وكمية البداية.', en: 'Add a product variant and set its SKU and starting quantity.' },
				target: { type: 'element', page: '/products', key: 'variant-form' },
				sortOrder: 3,
			},
		],
	},
	{
		key: 'add_first_supplier',
		title: { ar: 'أضف أول مورد', en: 'Add your first supplier' },
		description: { ar: 'الموردون يزودونك بالمنتجات والخامات التي تشتريها.', en: 'Suppliers provide the products and raw materials you purchase.' },
		completionType: GettingStartedAchievementType.FIRST_SUPPLIER_CREATED,
		dependsOn: [],
		sortOrder: 3,
		steps: [
			{
				key: 'open_suppliers_page',
				title: { ar: 'افتح صفحة الموردين', en: 'Open the Suppliers page' },
				description: { ar: 'انتقل إلى صفحة الموردين من القائمة الجانبية.', en: 'Navigate to Suppliers from the sidebar.' },
				target: { type: 'route', page: '/suppliers', key: 'suppliers' },
				sortOrder: 1,
			},
			{
				key: 'create_supplier',
				title: { ar: 'أضف موردًا', en: 'Add a supplier' },
				description: { ar: 'اضغط زر إضافة مورد واملأ بياناته.', en: 'Click "Add Supplier" and fill in the supplier details.' },
				target: { type: 'element', page: '/suppliers', key: 'add-supplier-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'add_first_safe',
		title: { ar: 'أضف أول خزنة', en: 'Add your first safe' },
		description: { ar: 'الخزن تتبع حساباتك النقدية وأرصدتك.', en: 'Safes track your cash accounts and balances.' },
		completionType: GettingStartedAchievementType.FIRST_SAFE_CREATED,
		dependsOn: [],
		sortOrder: 4,
		steps: [
			{
				key: 'open_safes_page',
				title: { ar: 'افتح صفحة الخزن', en: 'Open the Safes page' },
				description: { ar: 'انتقل إلى صفحة الخزن من القائمة الجانبية.', en: 'Navigate to Safes from the sidebar.' },
				target: { type: 'route', page: '/safes', key: 'safes' },
				sortOrder: 1,
			},
			{
				key: 'create_safe',
				title: { ar: 'أضف خزنة', en: 'Add a safe' },
				description: { ar: 'اضغط زر إضافة خزنة وحدد الرصيد الافتتاحي.', en: 'Click "Add Safe" and set the opening balance.' },
				target: { type: 'element', page: '/safes', key: 'add-safe-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'accept_first_purchase',
		title: { ar: 'اقبل أول عملية شراء', en: 'Accept your first purchase' },
		description: { ar: 'قبول عملية الشراء ينقل كمياتها إلى المخزون المتاح لديك.', en: 'Accepting a purchase moves its quantities into your available stock.' },
		completionType: GettingStartedAchievementType.FIRST_PURCHASE_ACCEPTED,
		dependsOn: ['add_first_supplier'],
		sortOrder: 5,
		steps: [
			{
				key: 'open_purchases_page',
				title: { ar: 'افتح صفحة المشتريات', en: 'Open the Purchases page' },
				description: { ar: 'انتقل إلى صفحة المشتريات من القائمة الجانبية.', en: 'Navigate to Purchases from the sidebar.' },
				target: { type: 'route', page: '/purchases', key: 'purchases' },
				sortOrder: 1,
			},
			{
				key: 'accept_purchase',
				title: { ar: 'اقبل فاتورة شراء', en: 'Accept a purchase invoice' },
				description: { ar: 'افتح فاتورة شراء واضغط زر قبول لتطبيق الكميات.', en: 'Open a purchase invoice and click Accept to apply the quantities.' },
				target: { type: 'element', page: '/purchases', key: 'accept-purchase-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'create_first_order',
		title: { ar: 'أنشئ أول طلب', en: 'Create your first order' },
		description: { ar: 'الطلبات هي قلب عملياتك. أنشئ طلبًا باستخدام منتجاتك.', en: 'Orders are the heart of your operations. Create one with your products.' },
		completionType: GettingStartedAchievementType.FIRST_ORDER_CREATED,
		dependsOn: ['add_first_product'],
		sortOrder: 7,
		steps: [
			{
				key: 'open_orders_page',
				title: { ar: 'افتح صفحة الطلبات', en: 'Open the Orders page' },
				description: { ar: 'انتقل إلى صفحة الطلبات من القائمة الجانبية.', en: 'Navigate to Orders from the sidebar.' },
				target: { type: 'route', page: '/orders', key: 'orders' },
				sortOrder: 1,
			},
			{
				key: 'create_order',
				title: { ar: 'أنشئ طلبًا', en: 'Create an order' },
				description: { ar: 'اضغط زر إنشاء طلب واختر العميل.', en: 'Click "New Order" and select the customer.' },
				target: { type: 'element', page: '/orders', key: 'add-order-button' },
				sortOrder: 2,
			},
			{
				key: 'add_order_items',
				title: { ar: 'أضف أصنافًا إلى الطلب', en: 'Add items to the order' },
				description: { ar: 'أضف المنتجات المطلوبة مع الكميات ثم احفظ الطلب.', en: 'Add the requested products with quantities, then save the order.' },
				target: { type: 'element', page: '/orders', key: 'order-items-form' },
				sortOrder: 3,
			},
		],
	},
	{
		key: 'connect_shipping_integration',
		title: { ar: 'اربط شركة شحن', en: 'Connect a shipping company' },
		description: { ar: 'اربط شركة شحن مثل بوسطة أو تيربو لإنشاء شحنات لطلباتك.', en: 'Connect a carrier like Bosta or Turbo to create shipments for your orders.' },
		completionType: GettingStartedAchievementType.SHIPPING_INTEGRATION_CONNECTED,
		dependsOn: ['create_first_order'],
		sortOrder: 8,
		steps: [
			{
				key: 'open_shipping_settings',
				title: { ar: 'افتح إعدادات الشحن', en: 'Open Shipping settings' },
				description: { ar: 'انتقل إلى إعدادات الشحن.', en: 'Navigate to the Shipping settings.' },
				target: { type: 'route', page: '/settings/shipping', key: 'shipping' },
				sortOrder: 1,
			},
			{
				key: 'connect_carrier',
				title: { ar: 'اربط شركة شحن', en: 'Connect a shipping company' },
				description: { ar: 'اختر شركة الشحن وأدخل مفاتيح الربط (API Key).', en: 'Choose the carrier and enter its API credentials.' },
				target: { type: 'element', page: '/settings/shipping', key: 'connect-carrier-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'connect_whatsapp',
		title: { ar: 'اربط واتساب', en: 'Connect WhatsApp' },
		description: { ar: 'اربط حساب واتساب بزنس للتواصل مع العملاء تلقائيًا.', en: 'Connect your WhatsApp Business account to chat with customers automatically.' },
		completionType: GettingStartedAchievementType.WHATSAPP_CONNECTED,
		dependsOn: [],
		sortOrder: 9,
		steps: [
			{
				key: 'open_whatsapp_settings',
				title: { ar: 'افتح إعدادات واتساب', en: 'Open WhatsApp settings' },
				description: { ar: 'انتقل إلى إعدادات واتساب.', en: 'Navigate to the WhatsApp settings.' },
				target: { type: 'route', page: '/settings/whatsapp', key: 'whatsapp' },
				sortOrder: 1,
			},
			{
				key: 'connect_whatsapp_account',
				title: { ar: 'اربط واتساب', en: 'Connect WhatsApp' },
				description: { ar: 'اضغط زر ربط واتساب وأكمل التسجيل من Meta.', en: 'Click "Connect WhatsApp" and complete the signup through Meta.' },
				target: { type: 'element', page: '/settings/whatsapp', key: 'connect-whatsapp-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'connect_store',
		title: { ar: 'اربط متجرًا', en: 'Connect a store' },
		description: { ar: 'اربط متجر Shopify أو WooCommerce أو Easy Order لمزامنة المنتجات والطلبات.', en: 'Connect Shopify, WooCommerce, or Easy Order to sync products and orders.' },
		completionType: GettingStartedAchievementType.STORE_CONNECTED,
		dependsOn: ['add_first_product'],
		sortOrder: 10,
		steps: [
			{
				key: 'open_stores_page',
				title: { ar: 'افتح صفحة المتاجر', en: 'Open the Stores page' },
				description: { ar: 'انتقل إلى صفحة المتاجر من القائمة الجانبية.', en: 'Navigate to Stores from the sidebar.' },
				target: { type: 'route', page: '/stores', key: 'stores' },
				sortOrder: 1,
			},
			{
				key: 'connect_store',
				title: { ar: 'اربط متجرك', en: 'Connect your store' },
				description: { ar: 'اختر نوع المتجر وأكمل خطوات الربط.', en: 'Choose the store type and complete the connection steps.' },
				target: { type: 'element', page: '/stores', key: 'connect-store-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'add_first_team_member',
		title: { ar: 'أضف أول عضو فريق', en: 'Add your first team member' },
		description: { ar: 'أضف زملاء إلى فريقك حتى يديروا النظام معك.', en: 'Invite teammates so your team can manage orders together.' },
		completionType: GettingStartedAchievementType.FIRST_TEAM_MEMBER_CREATED,
		dependsOn: [],
		sortOrder: 11,
		steps: [
			{
				key: 'open_team_page',
				title: { ar: 'افتح صفحة الفريق', en: 'Open the Team page' },
				description: { ar: 'انتقل إلى صفحة الفريق.', en: 'Navigate to the Team page.' },
				target: { type: 'route', page: '/team', key: 'team' },
				sortOrder: 1,
			},
			{
				key: 'invite_team_member',
				title: { ar: 'أضف عضو فريق', en: 'Invite a team member' },
				description: { ar: 'اضغط زر إضافة عضو وأدخل بياناته وحدد دوره.', en: 'Click "Add Member", enter their details, and assign a role.' },
				target: { type: 'element', page: '/team', key: 'invite-member-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'create_first_custom_role',
		title: { ar: 'أنشئ أول دور مخصص', en: 'Create your first custom role' },
		description: { ar: 'عرّف أدوارًا للتحكم فيما يمكن لفريقك الوصول إليه والقيام به.', en: 'Define roles to control what your team can access and do.' },
		completionType: GettingStartedAchievementType.FIRST_CUSTOM_ROLE_CREATED,
		dependsOn: ['add_first_team_member'],
		sortOrder: 12,
		steps: [
			{
				key: 'open_roles_page',
				title: { ar: 'افتح صفحة الأدوار', en: 'Open the Roles page' },
				description: { ar: 'انتقل إلى صفحة الأدوار.', en: 'Navigate to the Roles page.' },
				target: { type: 'route', page: '/roles', key: 'roles' },
				sortOrder: 1,
			},
			{
				key: 'create_custom_role',
				title: { ar: 'أنشئ دورًا مخصصًا', en: 'Create a custom role' },
				description: { ar: 'اضغط زر إنشاء دور وحدد الصلاحيات.', en: 'Click "Create Role" and choose the permissions.' },
				target: { type: 'element', page: '/roles', key: 'create-role-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'create_first_automation',
		title: { ar: 'أنشئ أول أتمتة', en: 'Create your first automation' },
		description: { ar: 'الأتمتة تُطلق إجراءات مثل الرسائل وتغيير الحالات تلقائيًا.', en: 'Automations trigger actions like messages and status changes automatically.' },
		completionType: GettingStartedAchievementType.FIRST_AUTOMATION_CREATED,
		dependsOn: ['create_first_order'],
		sortOrder: 13,
		steps: [
			{
				key: 'open_automations_page',
				title: { ar: 'افتح صفحة الأتمتة', en: 'Open the Automations page' },
				description: { ar: 'انتقل إلى صفحة الأتمتة.', en: 'Navigate to the Automations page.' },
				target: { type: 'route', page: '/automation', key: 'automation' },
				sortOrder: 1,
			},
			{
				key: 'create_automation',
				title: { ar: 'أنشئ أتمتة', en: 'Create an automation' },
				description: { ar: 'اضغط زر إنشاء أتمتة وحدد المثير والإجراء.', en: 'Click "New Automation", pick a trigger, and configure the action.' },
				target: { type: 'element', page: '/automation', key: 'create-automation-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'create_first_auto_assignment_rule',
		title: { ar: 'أنشئ أول قاعدة توزيع تلقائي', en: 'Create your first auto-assignment rule' },
		description: { ar: 'وزّع الطلبات تلقائيًا على الموظفين حسب المدن أو المنتجات وغيره من الطرق.', en: 'Auto-assign orders to employees based on cities, products, or availability.' },
		completionType: GettingStartedAchievementType.FIRST_ORDER_ASSIGNMENT_AUTOMATION_RULE_CREATED,
		dependsOn: ['add_first_team_member', 'create_first_order'],
		sortOrder: 14,
		steps: [
			{
				key: 'open_assignment_settings',
				title: { ar: 'افتح إعدادات توزيع الطلبات', en: 'Open the Order Assignment settings' },
				description: { ar: 'انتقل إلى إعدادات توزيع الطلبات.', en: 'Navigate to the Order Assignment settings.' },
				target: { type: 'route', page: '/settings/order-assignment', key: 'order-assignment' },
				sortOrder: 1,
			},
			{
				key: 'create_assignment_rule',
				title: { ar: 'أنشئ قاعدة توزيع تلقائي', en: 'Create an auto-assignment rule' },
				description: { ar: 'اضغط زر إنشاء قاعدة وحدد شروط التوزيع.', en: 'Click "New Rule" and define the assignment conditions.' },
				target: { type: 'element', page: '/settings/order-assignment', key: 'create-rule-button' },
				sortOrder: 2,
			},
		],
	},
	{
		key: 'create_first_order_bundle',
		title: { ar: 'أنشئ أول باندل', en: 'Create your first order bundle' },
		description: { ar: 'الباندل يجمّع عدة منتجات في صنف واحد قابل للبيع.', en: 'Bundles group several products into one saleable item.' },
		completionType: GettingStartedAchievementType.FIRST_ORDER_BUNDLE_CREATED,
		dependsOn: ['add_first_product'],
		sortOrder: 15,
		steps: [
			{
				key: 'open_bundles_page',
				title: { ar: 'افتح صفحة الباندلات', en: 'Open the Bundles page' },
				description: { ar: 'انتقل إلى صفحة الباندلات.', en: 'Navigate to the Bundles page.' },
				target: { type: 'route', page: '/bundles', key: 'bundles' },
				sortOrder: 1,
			},
			{
				key: 'create_bundle',
				title: { ar: 'أنشئ باندلًا', en: 'Create a bundle' },
				description: { ar: 'اضغط زر إنشاء باندل واختر المنتجات المكونة له.', en: 'Click "New Bundle" and select the products that compose it.' },
				target: { type: 'element', page: '/bundles', key: 'create-bundle-button' },
				sortOrder: 2,
			},
		],
	},
];

async function seedGettingStarted() {
	console.log('🌱 Seeding getting started checklist items and steps...');

	const itemRepo = dataSource.getRepository(GettingStartedItemEntity);
	const stepRepo = dataSource.getRepository(GettingStartedStepEntity);

	const existingItems = await itemRepo.find();
	const itemByKey = new Map(existingItems.map((item) => [item.key, item]));

	for (const checklistItem of gettingStartedChecklist) {
		const existingItem = itemByKey.get(checklistItem.key);
		const itemEntity = existingItem ?? itemRepo.create();
		Object.assign(itemEntity, {
			key: checklistItem.key,
			title: checklistItem.title,
			description: checklistItem.description,
			completionType: checklistItem.completionType,
			dependsOn: checklistItem.dependsOn,
			sortOrder: checklistItem.sortOrder,
			isActive: true,
		});
		const savedItem = await itemRepo.save(itemEntity);
		itemByKey.set(checklistItem.key, savedItem);

		const existingSteps = await stepRepo.find({ where: { itemId: savedItem.id } });
		const stepByKey = new Map(existingSteps.map((step) => [step.key, step]));

		for (const step of checklistItem.steps) {
			const existingStep = stepByKey.get(step.key);
			const stepEntity = existingStep ?? stepRepo.create();
			Object.assign(stepEntity, {
				itemId: savedItem.id,
				key: step.key,
				title: step.title,
				description: step.description,
				target: step.target,
				actionConfig: null,
				sortOrder: step.sortOrder,
			});
			const savedStep = await stepRepo.save(stepEntity);
			stepByKey.set(step.key, savedStep);
		}
	}

	console.log(`✅ Seeded ${gettingStartedChecklist.length} getting started checklist items`);
}

/**
 * =========================
 * Seed Orchestrator
 * =========================
 */
async function runGlobalSeed(seedName?: string) {
	
	switch (seedName) {
		case 'statuses':
			await seedOrderStatuses();
			break;

		case 'locations':
			await seedLocations();
			break;

		case 'super-admin':
			await seedSuperAdmin();
			break;

		case 'categories':
			await seedCategories();
			break;

		case 'warehouses':
			await seedWarehouses();
			break;

		case 'getting-started':
			await seedGettingStarted();
			break;

		case 'all':
		case undefined:
			console.log('🌱 Running global seeders...');
			await seedOrderStatuses();
			await seedLocations();
			await seedSuperAdmin();
			await seedCategories();
			await seedWarehouses();
			await seedGettingStarted();
			console.log('✅ Global seed completed');
			break;

		default:
			throw new Error(
				`Unknown seed: ${seedName}. Available seeds: statuses, locations, super-admin, categories, warehouses, getting-started, all`,
			);
	}
}

const seedName = process.argv[2];

dataSource
	.initialize()
	.then(async () => {
		await runGlobalSeed(seedName);
		await dataSource.destroy();
		process.exit(0);
	})
	.catch((err) => {
		console.error('❌ Seeder failed', err);
		process.exit(1);
	});
