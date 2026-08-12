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
	GettingStartedTargetType,
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
			name: 'المستودع الرئيسي',
			address: null,
			description: null,
			isActive: true,
		},
		{
			name: 'مستودع الطوارئ',
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

interface GettingStartedStepOpenFromPrevious {
	targetType: GettingStartedTargetType;
	page: string;
	targetKey: string;
	trigger: "click";
}

interface GettingStartedChecklistStep {
	key: string;
	title: { ar: string; en: string };
	description: { ar: string; en: string };
	target: { type: GettingStartedTargetType; page?: string; key: string };
	actionConfig?: { trigger?: "click"; openFromPreviousStep?: GettingStartedStepOpenFromPrevious } | null;
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
		key: "add_first_warehouse",

		title: {
			ar: "إضافة أول مستودع",
			en: "Add your first warehouse",
		},

		description: {
			ar: "أضف أول مستودع عشان تبدأ في تنظيم وإدارة مخزونك.",
			en: "Add your first warehouse to start organizing and managing your inventory.",
		},

		completionType: GettingStartedAchievementType.FIRST_WAREHOUSE_CREATED,

		dependsOn: [],

		sortOrder: 5,

		steps: [
			{
				key: "open_warehouse_management",
				title: {
					ar: "افتح إدارة المستودعات",
					en: "Open Warehouse Management",
				},
				description: {
					ar: "من القائمة الجانبية، افتح إدارة المستودعات الموجودة تحت قسم المنتجات.",
					en: "From the sidebar, open Warehouse Management under the Products section.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/warehouses-management",
					key: "products.warehouses_management",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_warehouse",
				title: {
					ar: "أنشئ المستودع",
					en: "Create the warehouse",
				},
				description: {
					ar: "اضغط على إضافة مستودع عشان تبدأ في إنشاء أول مستودع ليك.",
					en: "Click Add Warehouse to start creating your first warehouse.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/warehouses-management",
					key: "warehouses.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
			{
				key: "enter_warehouse_information",
				title: {
					ar: "أدخل بيانات المستودع",
					en: "Enter warehouse information",
				},
				description: {
					ar: "اكتب اسم المستودع والوصف، وبعدها احفظ المستودع.",
					en: "Enter the warehouse name and description, then save the warehouse.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/warehouses-management",
					key: "warehouses.create_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/warehouses-management",
						targetKey: "warehouses.create",
						trigger: "click",
					},
				},
				sortOrder: 3,
			},

			{
				key: "open_storage_locations",
				title: {
					ar: "افتح مواقع التخزين",
					en: "Open Storage Locations",
				},
				description: {
					ar: "بعد إنشاء المستودع، افتح مواقع التخزين عشان تقدر تنظم أماكن تخزين المنتجات داخله.",
					en: "After creating the warehouse, open Storage Locations to organize where products will be stored.",
				},
				target: {
					type: GettingStartedTargetType.SECTION,
					page: "/warehouses-management",
					key: "warehouse.storage_locations",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
			},
		],
	},
	{
		key: "add_first_product",

		title: {
			ar: "إضافة أول منتج",
			en: "Add your first product",
		},

		description: {
			ar: "أضف أول منتج عشان تبدأ في إدارة منتجاتك وطلباتك.",
			en: "Add your first product to start managing your products and orders.",
		},

		completionType: GettingStartedAchievementType.FIRST_PRODUCT_CREATED,

		dependsOn: ["add_first_warehouse"],

		sortOrder: 6,

		steps: [
			{
				key: "open_add_product",
				title: {
					ar: "إضافة منتج جديد",
					en: "Add a new product",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم المنتجات واضغط على إضافة منتج جديد.",
					en: "From the sidebar, open the Products section and click Add New Product.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/products",
					key: "sidebar_item_products_add",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "fill_product_information",
				title: {
					ar: "أدخل بيانات المنتج",
					en: "Enter product information",
				},
				description: {
					ar: "أدخل كل بيانات المنتج، زي الاسم والصور والـ SKU وباقي المعلومات، وأضف الـ Variants لو المنتج فيه أكتر من نوع أو شكل.",
					en: "Enter all the product information, including the name, images, SKU, and other details. Add variants if the product has different types or options.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/products/new",
					key: "product_dialog",
				},
				sortOrder: 2,
			},

			{
				key: "save_product",
				title: {
					ar: "احفظ المنتج",
					en: "Save the product",
				},
				description: {
					ar: "بعد ما تخلص كل بيانات المنتج، اضغط حفظ لإضافة المنتج.",
					en: "Once you finish entering all the product information, click Save to add the product.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/products/new",
					key: "product_save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 3,
			},
		],
	},
	{
		key: "add_first_order",

		title: {
			ar: "إنشاء أول طلب",
			en: "Create your first order",
		},

		description: {
			ar: "أنشئ أول طلب عشان تبدأ في إدارة طلباتك ومتابعتها.",
			en: "Create your first order to start managing and tracking your orders.",
		},

		completionType: GettingStartedAchievementType.FIRST_ORDER_CREATED,

		dependsOn: ["add_first_product"],

		sortOrder: 9,

		steps: [
			{
				key: "open_orders",
				title: {
					ar: "افتح الطلبات",
					en: "Open Orders",
				},
				description: {
					ar: "من القائمة الجانبية، افتح صفحة الطلبات.",
					en: "From the sidebar, open the Orders page.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/orders",
					key: "sidebar_item_orders",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_order",
				title: {
					ar: "أضف طلب جديد",
					en: "Add a new order",
				},
				description: {
					ar: "اضغط على إضافة طلب عشان تبدأ في إنشاء أول طلب ليك.",
					en: "Click Add Order to start creating your first order.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/orders",
					key: "orders.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
			{
				key: "fill_order_information",
				title: {
					ar: "أدخل بيانات الطلب",
					en: "Enter order information",
				},
				description: {
					ar: "أدخل كل بيانات الطلب، زي بيانات العميل والمنتجات وباقي المعلومات المطلوبة.",
					en: "Enter all the order information, including customer details, products, and the other required information.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/orders/new",
					key: "order_form",
				},
				sortOrder: 3,
			},

			{
				key: "save_order",
				title: {
					ar: "احفظ الطلب",
					en: "Save the order",
				},
				description: {
					ar: "بعد ما تخلص كل بيانات الطلب، اضغط حفظ لإضافة الطلب.",
					en: "Once you finish entering all the order information, click Save to create the order.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/orders/new",
					key: "order_save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
			},
		],
	},
	{
		key: "connect_shipping_company",
		title: {
			ar: "ربط شركة شحن",
			en: "Connect a shipping company",
		},

		description: {
			ar: "اربط أول شركة شحن عشان تقدر تستخدم خدمات الشحن وإدارة الشحنات من مدار.",
			en: "Connect your first shipping company to start managing your shipments through Madar.",
		},

		completionType:
			GettingStartedAchievementType.SHIPPING_INTEGRATION_CONNECTED,

		dependsOn: [],

		sortOrder: 2,

		steps:
			[
				{
					key: "open_shipping_companies",
					title: {
						ar: "افتح شركات الشحن",
						en: "Open Shipping Companies",
					},
					description: {
						ar: "من القائمة الجانبية، افتح قسم الربط والتكامل ثم اختر شركات الشحن.",
						en: "From the sidebar, open Integrations and select Shipping Companies.",
					},
					target: {
						type: GettingStartedTargetType.SIDEBAR_ITEM,
						page: "/shipping-companies",
						key: "integrations.shipping_companies", // Must match the DOM attribute: data-getting-started="integrations.shipping_companies"
					},
					actionConfig: { trigger: "click" },
					sortOrder: 1,
				},
				{
					key: "start_shipping_integration",
					title: {
						ar: "ابدأ ربط شركة الشحن",
						en: "Start the shipping integration",
					},
					description: {
						ar: "اضغط على إضافة لبدء ربط شركة الشحن، وهيظهر لك شرح وخطوات الربط.",
						en: "Click Add to start connecting the shipping company and view the integration instructions.",
					},
					target: {
						type: GettingStartedTargetType.BUTTON,
						page: "/shipping-companies",
						key: "shipping_company.add",
					},
					actionConfig: { trigger: "click" },
					sortOrder: 3,
				},

				{
					key: "learn_shipping_integration",
					title: {
						ar: "تعرف على طريقة الربط",
						en: "Learn how to integrate",
					},
					description: {
						ar: "راجع الخطوات والتعليمات المطلوبة لربط شركة الشحن مع مدار.",
						en: "Review the steps and instructions required to connect the shipping company to Madar.",
					},
					target: {
						type: GettingStartedTargetType.DIALOG,
						page: "/shipping-companies",
						key: "shipping_company.integration_dialog",
					},
					actionConfig: {
						openFromPreviousStep: {
							targetType: GettingStartedTargetType.BUTTON,
							page: "/shipping-companies",
							targetKey: "shipping_company.add",
							trigger: "click",
						},
					},
					sortOrder: 4,
				},

				{
					key: "open_shipping_settings",
					title: {
						ar: "افتح الإعدادات",
						en: "Open Settings",
					},
					description: {
						ar: "بعد ما تعرف خطوات الربط، اضغط على الإعدادات عشان تدخل بيانات شركة الشحن.",
						en: "After reviewing the integration instructions, click Settings to enter the shipping company details.",
					},
					target: {
						type: GettingStartedTargetType.BUTTON,
						page: "/shipping-companies",
						key: "shipping_company.settings",
					},
					actionConfig: { trigger: "click" },
					sortOrder: 5,
				},

				{
					key: "fill_shipping_settings",
					title: { ar: "أدخل بيانات الربط", en: "Enter the integration settings" },
					description: {
						ar: "أدخل بيانات وإعدادات شركة الشحن المطلوبة لإتمام عملية الربط، ثم اضغط حفظ.",
						en: "Enter the required shipping company settings to complete the integration, then click Save.",
					},
					target: {
						type: GettingStartedTargetType.DIALOG,
						page: "/shipping-companies",
						key: "shipping_company.settings_dialog",
					},
					actionConfig: {
						openFromPreviousStep: {
							targetType: GettingStartedTargetType.BUTTON,
							page: "/shipping-companies",
							targetKey: "shipping_company.settings",
							trigger: "click",
						},
					},
					sortOrder: 6, // or whatever
				}
			],
	},
	{
		key: "connect_whatsapp",

		title: {
			ar: "ربط واتساب",
			en: "Connect WhatsApp",
		},

		description: {
			ar: "اربط حساب واتساب للأعمال عشان تقدر تستخدم واتساب لإدارة والتواصل مع عملائك من مدار.",
			en: "Connect your WhatsApp Business account to start communicating with and managing your customers through Madar.",
		},

		completionType: GettingStartedAchievementType.WHATSAPP_CONNECTED,

		dependsOn: [],

		sortOrder: 10,

		steps: [
			{
				key: "open_whatsapp_accounts",
				title: {
					ar: "افتح حسابات واتساب",
					en: "Open WhatsApp Accounts",
				},
				description: {
					ar: "من القائمة الجانبية، افتح حسابات واتساب.",
					en: "From the sidebar, open WhatsApp Accounts.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/whatsapp/accounts",
					key: "whatsapp.accounts",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "integrate_meta_business_account",
				title: {
					ar: "اربط حساب أعمال Meta",
					en: "Connect Meta Business Account",
				},
				description: {
					ar: "اضغط على ربط حساب أعمال Meta لبدء ربط حساب واتساب للأعمال.",
					en: "Click Connect Meta Business Account to start connecting your WhatsApp Business account.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/whatsapp/accounts",
					key: "whatsapp.integrate_meta_business_account",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
		],
	},
	{
		key: "connect_store",

		title: {
			ar: "ربط متجر",
			en: "Connect a store",
		},

		description: {
			ar: "اربط أول متجر ليك عشان تقدر تدير طلبات متجرك من مدار.",
			en: "Connect your first store to start managing your store orders through Madar.",
		},

		completionType: GettingStartedAchievementType.STORE_CONNECTED,

		dependsOn: [],

		sortOrder: 1,

		steps: [

			{
				key: "open_stores",
				title: {
					ar: "افتح المتاجر",
					en: "Open Stores",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم الربط والتكامل ثم اختر المتاجر.",
					en: "From the sidebar, open Integrations and select Stores.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/store-integration",
					key: "integrations.stores",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},
			{
				key: "choose_store",
				title: {
					ar: "اختر المتجر",
					en: "Choose the store",
				},
				description: {
					ar: "اختار المتجر اللي عايز تربطه مع مدار.",
					en: "Choose the store you want to connect to Madar.",
				},
				target: {
					type: GettingStartedTargetType.SECTION,
					page: "/store-integration",
					key: "stores.available",
				},
				sortOrder: 2,
			},

			{
				key: "learn_store_integration",
				title: {
					ar: "تعرف على طريقة الربط",
					en: "Learn how to integrate",
				},
				description: {
					ar: "اضغط على كيفية الربط عشان تعرف خطوات ربط المتجر بالكامل.",
					en: "Click How to Integrate to learn the complete store integration steps.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/store-integration",
					key: "store.how_to_integrate",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 3,
			},

			{
				key: "view_store_integration_steps",
				title: {
					ar: "راجع خطوات الربط",
					en: "Review the integration steps",
				},
				description: {
					ar: "راجع الخطوات والتعليمات المطلوبة لربط المتجر مع مدار.",
					en: "Review the instructions and steps required to connect the store to Madar.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/store-integration",
					key: "store.integration_steps_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/store-integration",
						targetKey: "store.how_to_integrate",
						trigger: "click",
					},
				},
				sortOrder: 4,
			},

			{
				key: "open_store_settings",
				title: {
					ar: "افتح الإعدادات",
					en: "Open Settings",
				},
				description: {
					ar: "بعد ما تراجع خطوات الربط، افتح الإعدادات عشان تدخل بيانات المتجر المطلوبة.",
					en: "After reviewing the integration steps, open Settings to enter the required store configuration.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/store-integration",
					key: "store.settings",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 5,
			},

			{
				key: "fill_store_settings",
				title: {
					ar: "أدخل إعدادات المتجر",
					en: "Enter the store settings",
				},
				description: {
					ar: "أدخل بيانات وإعدادات المتجر المطلوبة لإتمام عملية الربط.",
					en: "Enter the required store configuration to complete the integration.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/store-integration",
					key: "store.settings_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/store-integration",
						targetKey: "store.settings",
						trigger: "click",
					},
				},
				sortOrder: 6,
			},

			{
				key: "integrate_store",
				title: {
					ar: "اربط المتجر",
					en: "Connect the store",
				},
				description: {
					ar: "بعد ما تدخل كل الإعدادات المطلوبة، اضغط ربط لإتمام عملية الربط. بعض المتاجر لا تتطلب تلمك الخطوة",
					en: "Once you enter all the required settings, click Integrate to complete the connection. Some stores do not require this step.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/store-integration",
					key: "store.integrate",
				},
				actionConfig: {
					trigger: "click",
				},
				sortOrder: 7,
			},
		],
	},
	{
		key: "add_first_team_member",

		title: {
			ar: "إضافة أول موظف",
			en: "Add your first team member",
		},

		description: {
			ar: "أضف أول موظف لفريقك عشان تبدأ في إدارة فريق العمل داخل مدار.",
			en: "Add your first team member to start managing your team in Madar.",
		},

		completionType:
			GettingStartedAchievementType.FIRST_TEAM_MEMBER_CREATED,

		dependsOn: [],

		sortOrder: 12,

		steps: [
			{
				key: "open_add_employees",
				title: {
					ar: "افتح الموظفين",
					en: "Open Employees",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم الفرق واضغط على إضافة موظفين.",
					en: "From the sidebar, open the Teams section and click Add Employees.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/employees",
					key: "teams.add_employees",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_employee",
				title: {
					ar: "أضف موظف جديد",
					en: "Add a new employee",
				},
				description: {
					ar: "اضغط على إضافة موظف عشان تبدأ في إضافة أول موظف لفريقك.",
					en: "Click Add Employee to start adding your first team member.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/employees",
					key: "employees.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},

			{
				key: "fill_employee_information",
				title: {
					ar: "أدخل بيانات الموظف",
					en: "Enter employee information",
				},
				description: {
					ar: "أدخل كل بيانات الموظف المطلوبة، وبعدها احفظ الموظف.",
					en: "Enter all the required employee information, then save the employee.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/employees/new",
					key: "employee_form",
				},
				sortOrder: 3,
			},

			{
				key: "save_employee",
				title: {
					ar: "احفظ الموظف",
					en: "Save the employee",
				},
				description: {
					ar: "بعد ما تخلص كل بيانات الموظف، اضغط حفظ لإضافة الموظف.",
					en: "Once you finish entering the employee information, click Save to add the employee.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/employees/new",
					key: "employee_save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
			},
		],
	},

	{
		key: "create_first_automation",

		title: {
			ar: "إنشاء أول مسار أتمتة",
			en: "Create your first automation",
		},

		description: {
			ar: "أنشئ أول مسار أتمتة عشان تبدأ في أتمتة المهام والعمليات داخل مدار.",
			en: "Create your first automation to start automating tasks and processes in Madar.",
		},

		completionType:
			GettingStartedAchievementType.FIRST_AUTOMATION_CREATED,

		dependsOn: [],

		sortOrder: 14,

		steps: [
			{
				key: "open_automations",
				title: {
					ar: "افتح مسارات الأتمتة",
					en: "Open Automations",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم الأتمتة والتشغيل ثم اختر مسارات الأتمتة.",
					en: "From the sidebar, open Automation & Operations and select Automations.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/automations",
					key: "automation.automations",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_automation",
				title: {
					ar: "أضف مسار أتمتة",
					en: "Add an automation",
				},
				description: {
					ar: "اضغط على إضافة مسار أتمتة عشان تبدأ في إنشاء أول مسار أتمتة ليك.",
					en: "Click Add Automation to start creating your first automation.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/automations",
					key: "automations.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
			{
				key: "add_automation_trigger",
				title: {
					ar: "أنشئ مسار الأتمتة",
					en: "Build your automation flow",
				},
				description: {
					ar: "في منشئ الأتمتة، أضف المشغّل ثم أضف الإجراءات والشروط اللي تناسب مسار الأتمتة حسب احتياجك.",
					en: "In the Automation Builder, add the trigger, then add the actions and conditions you need for your automation.",
				},
				target: {
					type: GettingStartedTargetType.SECTION,
					page: "/automations/builder",
					key: "automation_builder.trigger",
				},
				sortOrder: 3,
			},
			{
				key: "save_automation",
				title: {
					ar: "احفظ مسار الأتمتة",
					en: "Save the automation",
				},
				description: {
					ar: "بعد ما تخلص إعداد مسار الأتمتة، اضغط حفظ لإنشاء مسار الأتمتة.",
					en: "Once you finish configuring the automation, click Save to create the automation.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/automations/builder",
					key: "automation.save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
			},
		],
	},
	{
		key: "create_first_safe",

		title: {
			ar: "إضافة أول خزينة",
			en: "Add your first safe",
		},

		description: {
			ar: "أضف أول خزينة عشان تبدأ في إدارة حساباتك وأرصدتك داخل مدار.",
			en: "Add your first safe to start managing your accounts and balances in Madar.",
		},

		completionType: GettingStartedAchievementType.FIRST_SAFE_CREATED,

		dependsOn: [],

		sortOrder: 4,

		steps: [
			{
				key: "open_safes",
				title: {
					ar: "افتح الخزائن",
					en: "Open Safes",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم الحسابات ثم اختر الخزائن.",
					en: "From the sidebar, open Accounts and select Safes.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/accounts?tab=safes",
					key: "accounts.safes",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_safe",
				title: {
					ar: "أضف خزينة جديدة",
					en: "Add a new safe",
				},
				description: {
					ar: "اضغط على إضافة حساب جديد عشان تبدأ في إنشاء أول خزينة ليك.",
					en: "Click Add New Account to start creating your first safe.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/accounts?tab=safes",
					key: "safes.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
			{
				key: "fill_safe_information",
				title: {
					ar: "أدخل بيانات الخزينة",
					en: "Enter safe information",
				},
				description: {
					ar: "أدخل بيانات الخزينة، زي النوع والاسم والرصيد الافتتاحي والعمولة وباقي المعلومات المطلوبة، ثم اضغط حفظ لإضافتها.",
					en: "Enter the safe information, including its type, name, initial balance, commission, and other required details, then click Save to add it.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/accounts?tab=safes",
					key: "safes.create_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/accounts?tab=safes",
						targetKey: "safes.create",
						trigger: "click",
					},
				},
				sortOrder: 3, // unchanged
			}
		],
	},
	{
		key: "create_first_supplier",

		title: {
			ar: "إضافة أول مورد",
			en: "Add your first supplier",
		},

		description: {
			ar: "أضف أول مورد عشان تبدأ في إدارة الموردين والمشتريات داخل مدار.",
			en: "Add your first supplier to start managing suppliers and purchases in Madar.",
		},

		completionType: GettingStartedAchievementType.FIRST_SUPPLIER_CREATED,

		dependsOn: [],

		sortOrder: 3,

		steps: [
			{
				key: "open_suppliers",
				title: {
					ar: "افتح الموردين",
					en: "Open Suppliers",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم المشتريات ثم اختر الموردين.",
					en: "From the sidebar, open Purchases and select Suppliers.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/suppliers",
					key: "purchases.suppliers",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_supplier",
				title: {
					ar: "أضف مورد جديد",
					en: "Add a new supplier",
				},
				description: {
					ar: "اضغط على إضافة مورد عشان تبدأ في إضافة أول مورد ليك.",
					en: "Click Add Supplier to start adding your first supplier.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/suppliers",
					key: "suppliers.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},
			{
				key: "fill_supplier_information",
				title: {
					ar: "أدخل بيانات المورد",
					en: "Enter supplier information",
				},
				description: {
					ar: "أدخل كل بيانات المورد المطلوبة، ثم اضغط إضافة لحفظ المورد.",
					en: "Enter all the required supplier information, then click Add to save the supplier.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/suppliers",
					key: "suppliers.create_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/suppliers",
						targetKey: "suppliers.create",
						trigger: "click",
					},
				},
				sortOrder: 3, // unchanged
			}
		],
	},
	{
		key: "accept_first_purchase",

		title: {
			ar: "قبول أول عملية شراء",
			en: "Accept your first purchase",
		},

		description: {
			ar: "أنشئ أول عملية شراء واقبلها عشان تبدأ في تسجيل ومتابعة مشترياتك داخل مدار.",
			en: "Create and accept your first purchase to start managing your purchases in Madar.",
		},

		completionType: GettingStartedAchievementType.FIRST_PURCHASE_ACCEPTED,

		dependsOn: ["create_first_safe", "create_first_supplier"],

		sortOrder: 8,

		steps: [
			{
				key: "open_purchases",
				title: {
					ar: "افتح المشتريات",
					en: "Open Purchases",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم المشتريات ثم اختر المشتريات.",
					en: "From the sidebar, open Purchases and select Purchases.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/purchases",
					key: "purchases.purchases",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_purchase",
				title: {
					ar: "أضف عملية شراء",
					en: "Add a purchase",
				},
				description: {
					ar: "اضغط على إضافة ثم إضافة عملية شراء جديدة عشان تبدأ في إنشاء أول عملية شراء.",
					en: "Click Add and then Add New Purchase to start creating your first purchase.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/purchases",
					key: "purchases.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},

			{
				key: "fill_purchase_information",
				title: {
					ar: "أدخل بيانات الشراء",
					en: "Enter purchase information",
				},
				description: {
					ar: "أدخل بيانات عملية الشراء، زي رقم فاتورة الشراء والمنتجات والكميات وباقي المعلومات المطلوبة.",
					en: "Enter the purchase information, including the purchase invoice number, products, quantities, and other required details.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/purchases/new",
					key: "purchase_form",
				},
				sortOrder: 3,
			},

			{
				key: "save_purchase",
				title: {
					ar: "احفظ عملية الشراء",
					en: "Save the purchase",
				},
				description: {
					ar: "بعد ما تخلص بيانات عملية الشراء، اضغط حفظ لإضافتها.",
					en: "Once you finish entering the purchase information, click Save to add it.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/purchases/new",
					key: "purchase_save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
			},

			{
				key: "find_created_purchase",
				title: {
					ar: "افتح عملية الشراء",
					en: "Find the purchase",
				},
				description: {
					ar: "بعد الحفظ، هترجع لصفحة المشتريات. دور على عملية الشراء الجديدة في جدول المشتريات. و إقبلها.",
					en: "After saving, you will return to the Purchases page. Find the new purchase in the purchases table and accept it.",
				},
				target: {
					type: GettingStartedTargetType.SECTION,
					page: "/purchases",
					key: "purchases.table",
				},
				sortOrder: 5,
			},
		],
	},
	{
		key: "create_first_custom_role",

		title: {
			ar: "إنشاء أول دور مخصص",
			en: "Create your first custom role",
		},

		description: {
			ar: "أنشئ أول دور مخصص عشان تحدد صلاحيات الموظفين وإمكانية وصولهم داخل مدار.",
			en: "Create your first custom role to control employee permissions and access in Madar.",
		},

		completionType:
			GettingStartedAchievementType.FIRST_CUSTOM_ROLE_CREATED,

		dependsOn: [],

		sortOrder: 11,

		steps: [
			{
				key: "open_roles_permissions",
				title: {
					ar: "افتح الأدوار والصلاحيات",
					en: "Open Roles & Permissions",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم الفريق ثم اختر الأدوار والصلاحيات.",
					en: "From the sidebar, open the Teams section and select Roles & Permissions.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/roles",
					key: "teams.roles_permissions",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "create_role",
				title: {
					ar: "أضف دور جديد",
					en: "Add a new role",
				},
				description: {
					ar: "اضغط على إضافة دور جديد عشان تبدأ في إنشاء أول دور مخصص.",
					en: "Click Add New Role to start creating your first custom role.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/roles",
					key: "roles.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			}, {
				key: "fill_role_information",
				title: {
					ar: "أدخل بيانات الدور",
					en: "Enter role information",
				},
				description: {
					ar: "اكتب اسم الدور ووصفه، واختار الصلاحيات المناسبة، ثم اضغط حفظ لإنشاء الدور.",
					en: "Enter the role name and description, choose the appropriate permissions, then click Save to create the role.",
				},
				target: {
					type: GettingStartedTargetType.DIALOG,
					page: "/roles",
					key: "roles.create_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/roles",
						targetKey: "roles.create",
						trigger: "click",
					},
				},
				sortOrder: 3, // unchanged
			}
		],
	},
	{
		key: "create_first_order_bundle",

		title: {
			ar: "إنشاء أول باقة منتجات",
			en: "Create your first product bundle",
		},

		description: {
			ar: "أنشئ أول باقة منتجات عشان تقدر تجمع منتجاتك في باقة واحدة وتستخدمها في طلباتك.",
			en: "Create your first product bundle to combine products into a single bundle for your orders.",
		},

		completionType:
			GettingStartedAchievementType.FIRST_ORDER_BUNDLE_CREATED,

		dependsOn: [],

		sortOrder: 7,

		steps: [
			{
				key: "open_add_product_bundle",
				title: {
					ar: "افتح إضافة باقة منتجات",
					en: "Open Add Product Bundle",
				},
				description: {
					ar: "من القائمة الجانبية، افتح قسم المنتجات ثم اختر إضافة باقة منتجات.",
					en: "From the sidebar, open the Products section and select Add Product Bundle.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/bundles/new",
					key: "products.add_bundle",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},

			{
				key: "fill_bundle_information",
				title: {
					ar: "أدخل بيانات الباقة",
					en: "Enter bundle information",
				},
				description: {
					ar: "أدخل بيانات الباقة المطلوبة، وأضف الاشتراك وحدد الـ SKUs الخاصة بالمنتجات الموجودة في الباقة.",
					en: "Enter the required bundle information, add its subscription, and select the product SKUs included in the bundle.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/bundles/new",
					key: "product_bundle_form",
				},
				sortOrder: 2,
			},

			{
				key: "save_bundle",
				title: {
					ar: "احفظ الباقة",
					en: "Save the bundle",
				},
				description: {
					ar: "بعد ما تخلص بيانات الباقة وتحدد المنتجات والـ SKUs، اضغط حفظ لإنشاء الباقة.",
					en: "Once you finish the bundle information and select the products and SKUs, click Save to create the bundle.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/bundles/new",
					key: "product_bundle.save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 3,
			},
		],
	},
	{
		key: "create_first_order_assignment_automation_rule",

		title: {
			ar: "إنشاء أول قاعدة أتمتة لتوزيع الطلبات",
			en: "Create your first order assignment automation rule",
		},

		description: {
			ar: "أنشئ أول قاعدة أتمتة لتوزيع الطلبات عشان تساعدك في توزيع الطلبات تلقائيًا على فريق العمل.",
			en: "Create your first order assignment automation rule to help automatically assign orders to your team.",
		},

		completionType:
			GettingStartedAchievementType.FIRST_ORDER_ASSIGNMENT_AUTOMATION_RULE_CREATED,

		dependsOn: ["add_first_team_member"],

		sortOrder: 13,

		steps: [
			{
				key: "open_call_center",
				title: {
					ar: "افتح الكول سنتر",
					en: "Open Call Center",
				},
				description: {
					ar: "من القائمة الجانبية، افتح صفحة الكول سنتر.",
					en: "From the sidebar, open the Call Center page.",
				},
				target: {
					type: GettingStartedTargetType.SIDEBAR_ITEM,
					page: "/call-center?tab=automatic",
					key: "call_center",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 1,
			},
			{
				key: "create_order_assignment_rule",
				title: {
					ar: "أنشئ قاعدة أتمتة",
					en: "Create an automation rule",
				},
				description: {
					ar: "اضغط على إنشاء قاعدة أتمتة عشان تبدأ في إنشاء أول قاعدة لتوزيع الطلبات.",
					en: "Click Create Automation Rule to start creating your first order assignment rule.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/call-center?tab=automatic",
					key: "order_assignment_automation.create",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 2,
			},

			{
				key: "fill_order_assignment_rule",
				title: {
					ar: "أدخل بيانات قاعدة الأتمتة",
					en: "Enter the automation rule information",
				},
				description: {
					ar: "أدخل بيانات قاعدة الأتمتة والإعدادات المطلوبة لتحديد طريقة توزيع الطلبات.",
					en: "Enter the automation rule information and the required settings for assigning orders.",
				},
				target: {
					type: GettingStartedTargetType.PAGE,
					page: "/call-center?tab=automatic",
					key: "order_assignment_automation.create_dialog",
				},
				actionConfig: {
					openFromPreviousStep: {
						targetType: GettingStartedTargetType.BUTTON,
						page: "/call-center?tab=automatic",
						targetKey: "order_assignment_automation.create",
						trigger: "click",
					},
				},
				sortOrder: 3,
			},
			{
				key: "save_order_assignment_rule",
				title: {
					ar: "احفظ قاعدة الأتمتة",
					en: "Save the automation rule",
				},
				description: {
					ar: "بعد ما تخلص إعداد قاعدة الأتمتة، اضغط حفظ لإنشاء القاعدة.",
					en: "Once you finish configuring the automation rule, click Save to create it.",
				},
				target: {
					type: GettingStartedTargetType.BUTTON,
					page: "/call-center?tab=automatic",
					key: "order_assignment_automation.save",
				},
				actionConfig: { trigger: "click" },
				sortOrder: 4,
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
				actionConfig: step.actionConfig ?? null,
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
