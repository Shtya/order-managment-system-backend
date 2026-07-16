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
	const email = 'superAdmin@gmail.com';
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
 * Seeder Logic
 * =========================
 */
async function runGlobalSeed() {
	console.log('🌱 Running global seeders...');

	const categoryRepo = dataSource.getRepository(CategoryEntity);
	const warehouseRepo = dataSource.getRepository(WarehouseEntity);
	const statusRepo = dataSource.getRepository(OrderStatusEntity);
	const cityRepo = dataSource.getRepository(CityEntity);
	const areaRepo = dataSource.getRepository(AreaEntity);
	const providerLocationRepo = dataSource.getRepository(ProviderLocationEntity);
	const roleRepo = dataSource.getRepository(Role);
	const userRepo = dataSource.getRepository(User);

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
			name: 'Packed',
			code: OrderStatus.PACKED,
			isDefault: false,
			order: 18,
			color: '#795548' // Brown (Boxed and ready for pickup)
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

	// 1. Seed Unified Cities from CSV
	const seededCities = await seedCitiesFromCsv(cityRepo);
	console.log(`✅ Seeded ${seededCities.size} cities from cities.csv`);

	// 2. Seed Provider Locations from CSV
	await seedProviderLocationsFromCsv(providerLocationRepo, cityRepo);

	// 3. Seed Areas from CSV
	await seedAreasFromCsv(areaRepo, seededCities);

	// 4. Seed super admin user
	await seedSuperAdminUser(roleRepo, userRepo);

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

	/** =========================
	 * Global Warehouses
	 * ========================= */
	const warehouses = [
		{
			name: 'المخزن الرئيسي',
			location: null,
			managerUserId: null,
			phone: null,
			isActive: true,
		},
		{
			name: 'مخزن الطوارئ',
			location: null,
			managerUserId: null,
			phone: null,
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
					location: w.location ?? null,
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
	.catch((err) => {
		console.error('❌ Seeder failed', err);
		process.exit(1);
	});
