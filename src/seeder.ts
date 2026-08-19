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
import { AiAuthType, AiEntityScope, AiModelEntity, AiModelTier, AiModelType, AiProviderCode, AiProviderEntity, AiProviderProtocol } from 'entities/ai.entity';

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
        console.log('âš ï¸ cities.csv not found, skipping city seeding');
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
        console.log('âš ï¸ cities-provider.csv not found, skipping provider location seeding');
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
        console.log('âš ï¸ areas.csv not found, skipping area seeding');
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
            console.log(`âš ï¸ Skipping area ${row.nameEn} without a seeded city id (${row.cityId || 'missing'})`);
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

    console.log(`âœ… Super admin user seeded: ${normalizedEmail}`);
    console.log(`ðŸ” Generated password: ${password}`);
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
            name: 'PostPoned', code: OrderStatus.POSTPONED, isDefault: false, order: 3, color: '#00BCD4', // Ø³Ù…Ø§ÙˆÙŠ
        },
        {
            name: 'Confirmed', code: OrderStatus.CONFIRMED, isDefault: false, order: 4, color: '#4CAF50', // Ø£Ø®Ø¶Ø± (Ù†Ø¬Ø§Ø­ Ø§Ù„ØªØ£ÙƒÙŠØ¯)
        },
        {
            name: 'No Answer', code: OrderStatus.NO_ANSWER, isDefault: false, order: 5, color: '#FF5722', // Ø¨Ø±ØªÙ‚Ø§Ù„ÙŠ Ù…Ø­Ø±ÙˆÙ‚ (ØªØ­Ø°ÙŠØ±)
        },
        {
            name: 'No Answer - Follow Up', code: OrderStatus.NO_ANSWER_FOLLOW_UP, isDefault: false, order: 6, color: '#FF5722', // Same as No Answer
        },
        {
            name: 'Wrong Number', code: OrderStatus.WRONG_NUMBER, isDefault: false, order: 7, color: '#795548', // Ø¨Ù†ÙŠ
        },
        {
            name: 'Out of Delivery Area', code: OrderStatus.OUT_OF_DELIVERY_AREA, isDefault: false, order: 8, color: '#673AB7', // Ø¨Ù†ÙØ³Ø¬ÙŠ ØºØ§Ù…Ù‚
        },
        {
            name: 'Duplicate', code: OrderStatus.DUPLICATE, isDefault: false, order: 9, color: '#E91E63', // ÙˆØ±Ø¯ÙŠ (ØªÙ†Ø¨ÙŠÙ‡ ØªÙƒØ±Ø§Ø±)
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
    console.log('ðŸŒ± Seeding locations (cities, provider locations, areas)...');

    const cityRepo = dataSource.getRepository(CityEntity);
    const areaRepo = dataSource.getRepository(AreaEntity);
    const providerLocationRepo = dataSource.getRepository(ProviderLocationEntity);

    // 1. Seed Unified Cities from CSV
    const seededCities = await seedCitiesFromCsv(cityRepo);
    console.log(`âœ… Seeded ${seededCities.size} cities from cities.csv`);

    // 2. Seed Provider Locations from CSV
    await seedProviderLocationsFromCsv(providerLocationRepo, cityRepo);

    // 3. Seed Areas from CSV
    await seedAreasFromCsv(areaRepo, seededCities);
}

async function seedSuperAdmin() {
    console.log('ðŸŒ± Seeding super admin...');

    const roleRepo = dataSource.getRepository(Role);
    const userRepo = dataSource.getRepository(User);

    await seedSuperAdminUser(roleRepo, userRepo);
}

async function seedCategories() {
    console.log('ðŸŒ± Seeding global categories...');

    const categoryRepo = dataSource.getRepository(CategoryEntity);

    /** =========================
     * Global Categories
     * ========================= */
    const categories = [
        {
            name: 'Ø¹Ø§Ù…',
            slug: 'aam',
            image: null,
            adminId: null,
        },
        {
            name: 'Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠØ§Øª',
            slug: 'electronics',
            image: null,
            adminId: null,
        },
        {
            name: 'Ù…Ù„Ø§Ø¨Ø³',
            slug: 'clothing',
            image: null,
            adminId: null,
        },
        {
            name: 'Ø£ØºØ°ÙŠØ©',
            slug: 'food',
            image: null,
            adminId: null,
        },
        {
            name: 'Ù…Ø³ØªÙ„Ø²Ù…Ø§Øª Ù…Ù†Ø²Ù„ÙŠØ©',
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
    console.log('ðŸŒ± Seeding global warehouses...');

    const warehouseRepo = dataSource.getRepository(WarehouseEntity);

    /** =========================
     * Global Warehouses
     * ========================= */
    const warehouses = [
        {
            name: 'Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹ Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠ',
            address: null,
            description: null,
            isActive: true,
        },
        {
            name: 'Ù…Ø³ØªÙˆØ¯Ø¹ Ø§Ù„Ø·ÙˆØ§Ø±Ø¦',
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
    groupNumber?: number;
    steps: GettingStartedChecklistStep[];
}

const gettingStartedChecklist: GettingStartedChecklistItem[] = [
    {
        key: "add_first_warehouse",

        title: {
            ar: "Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…Ø³ØªÙˆØ¯Ø¹",
            en: "Add your first warehouse",
        },

        description: {
            ar: "Ø£Ø¶Ù Ø£ÙˆÙ„ Ù…Ø³ØªÙˆØ¯Ø¹ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ ØªÙ†Ø¸ÙŠÙ… ÙˆØ¥Ø¯Ø§Ø±Ø© Ù…Ø®Ø²ÙˆÙ†Ùƒ.",
            en: "Add your first warehouse to start organizing and managing your inventory.",
        },

        completionType: GettingStartedAchievementType.FIRST_WAREHOUSE_CREATED,

        dependsOn: [],

        sortOrder: 5,
        steps: [
            {
                key: "open_warehouse_management",
                title: {
                    ar: "Ø§ÙØªØ­ Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹Ø§Øª",
                    en: "Open Warehouse Management",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹Ø§Øª Ø§Ù„Ù…ÙˆØ¬ÙˆØ¯Ø© ØªØ­Øª Ù‚Ø³Ù… Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª.",
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
                    ar: "Ø£Ù†Ø´Ø¦ Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹",
                    en: "Create the warehouse",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…Ø³ØªÙˆØ¯Ø¹ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ù…Ø³ØªÙˆØ¯Ø¹ Ù„ÙŠÙƒ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹",
                    en: "Enter warehouse information",
                },
                description: {
                    ar: "Ø§ÙƒØªØ¨ Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹ ÙˆØ§Ù„ÙˆØµÙØŒ ÙˆØ¨Ø¹Ø¯Ù‡Ø§ Ø§Ø­ÙØ¸ Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹.",
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
                    ar: "Ø§ÙØªØ­ Ù…ÙˆØ§Ù‚Ø¹ Ø§Ù„ØªØ®Ø²ÙŠÙ†",
                    en: "Open Storage Locations",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ø³ØªÙˆØ¯Ø¹ØŒ Ø§ÙØªØ­ Ù…ÙˆØ§Ù‚Ø¹ Ø§Ù„ØªØ®Ø²ÙŠÙ† Ø¹Ø´Ø§Ù† ØªÙ‚Ø¯Ø± ØªÙ†Ø¸Ù… Ø£Ù…Ø§ÙƒÙ† ØªØ®Ø²ÙŠÙ† Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª Ø¯Ø§Ø®Ù„Ù‡.",
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
            ar: "Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…Ù†ØªØ¬",
            en: "Add your first product",
        },

        description: {
            ar: "Ø£Ø¶Ù Ø£ÙˆÙ„ Ù…Ù†ØªØ¬ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¯Ø§Ø±Ø© Ù…Ù†ØªØ¬Ø§ØªÙƒ ÙˆØ·Ù„Ø¨Ø§ØªÙƒ.",
            en: "Add your first product to start managing your products and orders.",
        },

        completionType: GettingStartedAchievementType.FIRST_PRODUCT_CREATED,

        dependsOn: ["add_first_warehouse"],

        sortOrder: 6,

        steps: [
            {
                key: "open_add_product",
                title: {
                    ar: "Ø¥Ø¶Ø§ÙØ© Ù…Ù†ØªØ¬ Ø¬Ø¯ÙŠØ¯",
                    en: "Add a new product",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª ÙˆØ§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…Ù†ØªØ¬ Ø¬Ø¯ÙŠØ¯.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ù†ØªØ¬",
                    en: "Enter product information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ù†ØªØ¬ØŒ Ø²ÙŠ Ø§Ù„Ø§Ø³Ù… ÙˆØ§Ù„ØµÙˆØ± ÙˆØ§Ù„Ù€ SKU ÙˆØ¨Ø§Ù‚ÙŠ Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§ØªØŒ ÙˆØ£Ø¶Ù Ø§Ù„Ù€ Variants Ù„Ùˆ Ø§Ù„Ù…Ù†ØªØ¬ ÙÙŠÙ‡ Ø£ÙƒØªØ± Ù…Ù† Ù†ÙˆØ¹ Ø£Ùˆ Ø´ÙƒÙ„.",
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
                    ar: "Ø§Ø­ÙØ¸ Ø§Ù„Ù…Ù†ØªØ¬",
                    en: "Save the product",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ù†ØªØ¬ØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù…Ù†ØªØ¬.",
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
            ar: "Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø·Ù„Ø¨",
            en: "Create your first order",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ø·Ù„Ø¨ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¯Ø§Ø±Ø© Ø·Ù„Ø¨Ø§ØªÙƒ ÙˆÙ…ØªØ§Ø¨Ø¹ØªÙ‡Ø§.",
            en: "Create your first order to start managing and tracking your orders.",
        },

        completionType: GettingStartedAchievementType.FIRST_ORDER_CREATED,

        dependsOn: ["add_first_product"],

        sortOrder: 9,

        steps: [
            {
                key: "open_orders",
                title: {
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ø·Ù„Ø¨Ø§Øª",
                    en: "Open Orders",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ ØµÙØ­Ø© Ø§Ù„Ø·Ù„Ø¨Ø§Øª.",
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
                    ar: "Ø£Ø¶Ù Ø·Ù„Ø¨ Ø¬Ø¯ÙŠØ¯",
                    en: "Add a new order",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ø·Ù„Ø¨ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø·Ù„Ø¨ Ù„ÙŠÙƒ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø·Ù„Ø¨",
                    en: "Enter order information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø·Ù„Ø¨ØŒ Ø²ÙŠ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¹Ù…ÙŠÙ„ ÙˆØ§Ù„Ù…Ù†ØªØ¬Ø§Øª ÙˆØ¨Ø§Ù‚ÙŠ Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©.",
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
                    ar: "Ø§Ø­ÙØ¸ Ø§Ù„Ø·Ù„Ø¨",
                    en: "Save the order",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø·Ù„Ø¨ØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ø·Ù„Ø¨.",
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
            ar: "Ø±Ø¨Ø· Ø´Ø±ÙƒØ© Ø´Ø­Ù†",
            en: "Connect a shipping company",
        },

        description: {
            ar: "Ø§Ø±Ø¨Ø· Ø£ÙˆÙ„ Ø´Ø±ÙƒØ© Ø´Ø­Ù† Ø¹Ø´Ø§Ù† ØªÙ‚Ø¯Ø± ØªØ³ØªØ®Ø¯Ù… Ø®Ø¯Ù…Ø§Øª Ø§Ù„Ø´Ø­Ù† ÙˆØ¥Ø¯Ø§Ø±Ø© Ø§Ù„Ø´Ø­Ù†Ø§Øª Ù…Ù† Ù…Ø¯Ø§Ø±.",
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
                        ar: "Ø§ÙØªØ­ Ø´Ø±ÙƒØ§Øª Ø§Ù„Ø´Ø­Ù†",
                        en: "Open Shipping Companies",
                    },
                    description: {
                        ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ø±Ø¨Ø· ÙˆØ§Ù„ØªÙƒØ§Ù…Ù„ Ø«Ù… Ø§Ø®ØªØ± Ø´Ø±ÙƒØ§Øª Ø§Ù„Ø´Ø­Ù†.",
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
                        ar: "Ø§Ø¨Ø¯Ø£ Ø±Ø¨Ø· Ø´Ø±ÙƒØ© Ø§Ù„Ø´Ø­Ù†",
                        en: "Start the shipping integration",
                    },
                    description: {
                        ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù„Ø¨Ø¯Ø¡ Ø±Ø¨Ø· Ø´Ø±ÙƒØ© Ø§Ù„Ø´Ø­Ù†ØŒ ÙˆÙ‡ÙŠØ¸Ù‡Ø± Ù„Ùƒ Ø´Ø±Ø­ ÙˆØ®Ø·ÙˆØ§Øª Ø§Ù„Ø±Ø¨Ø·.",
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
                        ar: "ØªØ¹Ø±Ù Ø¹Ù„Ù‰ Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø±Ø¨Ø·",
                        en: "Learn how to integrate",
                    },
                    description: {
                        ar: "Ø±Ø§Ø¬Ø¹ Ø§Ù„Ø®Ø·ÙˆØ§Øª ÙˆØ§Ù„ØªØ¹Ù„ÙŠÙ…Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© Ù„Ø±Ø¨Ø· Ø´Ø±ÙƒØ© Ø§Ù„Ø´Ø­Ù† Ù…Ø¹ Ù…Ø¯Ø§Ø±.",
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
                        ar: "Ø§ÙØªØ­ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª",
                        en: "Open Settings",
                    },
                    description: {
                        ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ¹Ø±Ù Ø®Ø·ÙˆØ§Øª Ø§Ù„Ø±Ø¨Ø·ØŒ Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø¹Ø´Ø§Ù† ØªØ¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø´Ø±ÙƒØ© Ø§Ù„Ø´Ø­Ù†.",
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
                    title: { ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø±Ø¨Ø·", en: "Enter the integration settings" },
                    description: {
                        ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª ÙˆØ¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø´Ø±ÙƒØ© Ø§Ù„Ø´Ø­Ù† Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© Ù„Ø¥ØªÙ…Ø§Ù… Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø±Ø¨Ø·ØŒ Ø«Ù… Ø§Ø¶ØºØ· Ø­ÙØ¸.",
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
            ar: "Ø±Ø¨Ø· ÙˆØ§ØªØ³Ø§Ø¨",
            en: "Connect WhatsApp",
        },

        description: {
            ar: "Ø§Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ ÙˆØ§ØªØ³Ø§Ø¨ Ù„Ù„Ø£Ø¹Ù…Ø§Ù„ Ø¹Ø´Ø§Ù† ØªÙ‚Ø¯Ø± ØªØ³ØªØ®Ø¯Ù… ÙˆØ§ØªØ³Ø§Ø¨ Ù„Ø¥Ø¯Ø§Ø±Ø© ÙˆØ§Ù„ØªÙˆØ§ØµÙ„ Ù…Ø¹ Ø¹Ù…Ù„Ø§Ø¦Ùƒ Ù…Ù† Ù…Ø¯Ø§Ø±.",
            en: "Connect your WhatsApp Business account to start communicating with and managing your customers through Madar.",
        },

        completionType: GettingStartedAchievementType.WHATSAPP_CONNECTED,

        dependsOn: [],

        sortOrder: 10,

        steps: [
            {
                key: "open_whatsapp_accounts",
                title: {
                    ar: "Ø§ÙØªØ­ Ø­Ø³Ø§Ø¨Ø§Øª ÙˆØ§ØªØ³Ø§Ø¨",
                    en: "Open WhatsApp Accounts",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ø­Ø³Ø§Ø¨Ø§Øª ÙˆØ§ØªØ³Ø§Ø¨.",
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
                    ar: "Ø§Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ Ø£Ø¹Ù…Ø§Ù„ Meta",
                    en: "Connect Meta Business Account",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ Ø£Ø¹Ù…Ø§Ù„ Meta Ù„Ø¨Ø¯Ø¡ Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ ÙˆØ§ØªØ³Ø§Ø¨ Ù„Ù„Ø£Ø¹Ù…Ø§Ù„.",
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
            ar: "Ø±Ø¨Ø· Ù…ØªØ¬Ø±",
            en: "Connect a store",
        },

        description: {
            ar: "Ø§Ø±Ø¨Ø· Ø£ÙˆÙ„ Ù…ØªØ¬Ø± Ù„ÙŠÙƒ Ø¹Ø´Ø§Ù† ØªÙ‚Ø¯Ø± ØªØ¯ÙŠØ± Ø·Ù„Ø¨Ø§Øª Ù…ØªØ¬Ø±Ùƒ Ù…Ù† Ù…Ø¯Ø§Ø±.",
            en: "Connect your first store to start managing your store orders through Madar.",
        },

        completionType: GettingStartedAchievementType.STORE_CONNECTED,

        dependsOn: [],

        sortOrder: 1,

        steps: [

            {
                key: "open_stores",
                title: {
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ù…ØªØ§Ø¬Ø±",
                    en: "Open Stores",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ø±Ø¨Ø· ÙˆØ§Ù„ØªÙƒØ§Ù…Ù„ Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ù…ØªØ§Ø¬Ø±.",
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
                    ar: "Ø§Ø®ØªØ± Ø§Ù„Ù…ØªØ¬Ø±",
                    en: "Choose the store",
                },
                description: {
                    ar: "Ø§Ø®ØªØ§Ø± Ø§Ù„Ù…ØªØ¬Ø± Ø§Ù„Ù„ÙŠ Ø¹Ø§ÙŠØ² ØªØ±Ø¨Ø·Ù‡ Ù…Ø¹ Ù…Ø¯Ø§Ø±.",
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
                    ar: "ØªØ¹Ø±Ù Ø¹Ù„Ù‰ Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø±Ø¨Ø·",
                    en: "Learn how to integrate",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ ÙƒÙŠÙÙŠØ© Ø§Ù„Ø±Ø¨Ø· Ø¹Ø´Ø§Ù† ØªØ¹Ø±Ù Ø®Ø·ÙˆØ§Øª Ø±Ø¨Ø· Ø§Ù„Ù…ØªØ¬Ø± Ø¨Ø§Ù„ÙƒØ§Ù…Ù„.",
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
                    ar: "Ø±Ø§Ø¬Ø¹ Ø®Ø·ÙˆØ§Øª Ø§Ù„Ø±Ø¨Ø·",
                    en: "Review the integration steps",
                },
                description: {
                    ar: "Ø±Ø§Ø¬Ø¹ Ø§Ù„Ø®Ø·ÙˆØ§Øª ÙˆØ§Ù„ØªØ¹Ù„ÙŠÙ…Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© Ù„Ø±Ø¨Ø· Ø§Ù„Ù…ØªØ¬Ø± Ù…Ø¹ Ù…Ø¯Ø§Ø±.",
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
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª",
                    en: "Open Settings",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ±Ø§Ø¬Ø¹ Ø®Ø·ÙˆØ§Øª Ø§Ù„Ø±Ø¨Ø·ØŒ Ø§ÙØªØ­ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø¹Ø´Ø§Ù† ØªØ¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ØªØ¬Ø± Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…ØªØ¬Ø±",
                    en: "Enter the store settings",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª ÙˆØ¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…ØªØ¬Ø± Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© Ù„Ø¥ØªÙ…Ø§Ù… Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø±Ø¨Ø·.",
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
        ],
    },
    {
        key: "add_first_team_member",

        title: {
            ar: "Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…ÙˆØ¸Ù",
            en: "Add your first team member",
        },

        description: {
            ar: "Ø£Ø¶Ù Ø£ÙˆÙ„ Ù…ÙˆØ¸Ù Ù„ÙØ±ÙŠÙ‚Ùƒ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¯Ø§Ø±Ø© ÙØ±ÙŠÙ‚ Ø§Ù„Ø¹Ù…Ù„ Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
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
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ù…ÙˆØ¸ÙÙŠÙ†",
                    en: "Open Employees",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„ÙØ±Ù‚ ÙˆØ§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ¸ÙÙŠÙ†.",
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
                    ar: "Ø£Ø¶Ù Ù…ÙˆØ¸Ù Ø¬Ø¯ÙŠØ¯",
                    en: "Add a new employee",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ¸Ù Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…ÙˆØ¸Ù Ù„ÙØ±ÙŠÙ‚Ùƒ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ÙˆØ¸Ù",
                    en: "Enter employee information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ÙˆØ¸Ù Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©ØŒ ÙˆØ¨Ø¹Ø¯Ù‡Ø§ Ø§Ø­ÙØ¸ Ø§Ù„Ù…ÙˆØ¸Ù.",
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
                    ar: "Ø§Ø­ÙØ¸ Ø§Ù„Ù…ÙˆØ¸Ù",
                    en: "Save the employee",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ÙˆØ¸ÙØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù…ÙˆØ¸Ù.",
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
            ar: "Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ù…Ø³Ø§Ø± Ø£ØªÙ…ØªØ©",
            en: "Create your first automation",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ù…Ø³Ø§Ø± Ø£ØªÙ…ØªØ© Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø£ØªÙ…ØªØ© Ø§Ù„Ù…Ù‡Ø§Ù… ÙˆØ§Ù„Ø¹Ù…Ù„ÙŠØ§Øª Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
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
                    ar: "Ø§ÙØªØ­ Ù…Ø³Ø§Ø±Ø§Øª Ø§Ù„Ø£ØªÙ…ØªØ©",
                    en: "Open Automations",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ø£ØªÙ…ØªØ© ÙˆØ§Ù„ØªØ´ØºÙŠÙ„ Ø«Ù… Ø§Ø®ØªØ± Ù…Ø³Ø§Ø±Ø§Øª Ø§Ù„Ø£ØªÙ…ØªØ©.",
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
                    ar: "Ø£Ø¶Ù Ù…Ø³Ø§Ø± Ø£ØªÙ…ØªØ©",
                    en: "Add an automation",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…Ø³Ø§Ø± Ø£ØªÙ…ØªØ© Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ù…Ø³Ø§Ø± Ø£ØªÙ…ØªØ© Ù„ÙŠÙƒ.",
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
                    ar: "Ø£Ù†Ø´Ø¦ Ù…Ø³Ø§Ø± Ø§Ù„Ø£ØªÙ…ØªØ©",
                    en: "Build your automation flow",
                },
                description: {
                    ar: "ÙÙŠ Ù…Ù†Ø´Ø¦ Ø§Ù„Ø£ØªÙ…ØªØ©ØŒ Ø£Ø¶Ù Ø§Ù„Ù…Ø´ØºÙ‘Ù„ Ø«Ù… Ø£Ø¶Ù Ø§Ù„Ø¥Ø¬Ø±Ø§Ø¡Ø§Øª ÙˆØ§Ù„Ø´Ø±ÙˆØ· Ø§Ù„Ù„ÙŠ ØªÙ†Ø§Ø³Ø¨ Ù…Ø³Ø§Ø± Ø§Ù„Ø£ØªÙ…ØªØ© Ø­Ø³Ø¨ Ø§Ø­ØªÙŠØ§Ø¬Ùƒ.",
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
                    ar: "Ø§Ø­ÙØ¸ Ù…Ø³Ø§Ø± Ø§Ù„Ø£ØªÙ…ØªØ©",
                    en: "Save the automation",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ Ø¥Ø¹Ø¯Ø§Ø¯ Ù…Ø³Ø§Ø± Ø§Ù„Ø£ØªÙ…ØªØ©ØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ù†Ø´Ø§Ø¡ Ù…Ø³Ø§Ø± Ø§Ù„Ø£ØªÙ…ØªØ©.",
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
            ar: "Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ø®Ø²ÙŠÙ†Ø©",
            en: "Add your first safe",
        },

        description: {
            ar: "Ø£Ø¶Ù Ø£ÙˆÙ„ Ø®Ø²ÙŠÙ†Ø© Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¯Ø§Ø±Ø© Ø­Ø³Ø§Ø¨Ø§ØªÙƒ ÙˆØ£Ø±ØµØ¯ØªÙƒ Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
            en: "Add your first safe to start managing your accounts and balances in Madar.",
        },

        completionType: GettingStartedAchievementType.FIRST_SAFE_CREATED,

        dependsOn: [],

        groupNumber: 1,

        sortOrder: 4,

        steps: [
            {
                key: "open_safes",
                title: {
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ø®Ø²Ø§Ø¦Ù†",
                    en: "Open Safes",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ø­Ø³Ø§Ø¨Ø§Øª Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ø®Ø²Ø§Ø¦Ù†.",
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
                    ar: "Ø£Ø¶Ù Ø®Ø²ÙŠÙ†Ø© Ø¬Ø¯ÙŠØ¯Ø©",
                    en: "Add a new safe",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ø­Ø³Ø§Ø¨ Ø¬Ø¯ÙŠØ¯ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø®Ø²ÙŠÙ†Ø© Ù„ÙŠÙƒ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø®Ø²ÙŠÙ†Ø©",
                    en: "Enter safe information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø®Ø²ÙŠÙ†Ø©ØŒ Ø²ÙŠ Ø§Ù„Ù†ÙˆØ¹ ÙˆØ§Ù„Ø§Ø³Ù… ÙˆØ§Ù„Ø±ØµÙŠØ¯ Ø§Ù„Ø§ÙØªØªØ§Ø­ÙŠ ÙˆØ§Ù„Ø¹Ù…ÙˆÙ„Ø© ÙˆØ¨Ø§Ù‚ÙŠ Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©ØŒ Ø«Ù… Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ø¶Ø§ÙØªÙ‡Ø§.",
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
            ar: "Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…ÙˆØ±Ø¯",
            en: "Add your first supplier",
        },

        description: {
            ar: "Ø£Ø¶Ù Ø£ÙˆÙ„ Ù…ÙˆØ±Ø¯ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù…ÙˆØ±Ø¯ÙŠÙ† ÙˆØ§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
            en: "Add your first supplier to start managing suppliers and purchases in Madar.",
        },

        completionType: GettingStartedAchievementType.FIRST_SUPPLIER_CREATED,

        dependsOn: [],

        groupNumber: 1,

        sortOrder: 3,

        steps: [
            {
                key: "open_suppliers",
                title: {
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ù…ÙˆØ±Ø¯ÙŠÙ†",
                    en: "Open Suppliers",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ù…ÙˆØ±Ø¯ÙŠÙ†.",
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
                    ar: "Ø£Ø¶Ù Ù…ÙˆØ±Ø¯ Ø¬Ø¯ÙŠØ¯",
                    en: "Add a new supplier",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ±Ø¯ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ù…ÙˆØ±Ø¯ Ù„ÙŠÙƒ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ÙˆØ±Ø¯",
                    en: "Enter supplier information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ ÙƒÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…ÙˆØ±Ø¯ Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©ØŒ Ø«Ù… Ø§Ø¶ØºØ· Ø¥Ø¶Ø§ÙØ© Ù„Ø­ÙØ¸ Ø§Ù„Ù…ÙˆØ±Ø¯.",
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
            ar: "Ù‚Ø¨ÙˆÙ„ Ø£ÙˆÙ„ Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡",
            en: "Accept your first purchase",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡ ÙˆØ§Ù‚Ø¨Ù„Ù‡Ø§ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ ØªØ³Ø¬ÙŠÙ„ ÙˆÙ…ØªØ§Ø¨Ø¹Ø© Ù…Ø´ØªØ±ÙŠØ§ØªÙƒ Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
            en: "Create and accept your first purchase to start managing your purchases in Madar.",
        },

        completionType: GettingStartedAchievementType.FIRST_PURCHASE_ACCEPTED,

        dependsOn: ["create_first_safe", "create_first_supplier"],

        groupNumber: 1,

        sortOrder: 8,

        steps: [
            {
                key: "open_purchases",
                title: {
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª",
                    en: "Open Purchases",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª.",
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
                    ar: "Ø£Ø¶Ù Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡",
                    en: "Add a purchase",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ø«Ù… Ø¥Ø¶Ø§ÙØ© Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡ Ø¬Ø¯ÙŠØ¯Ø© Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø´Ø±Ø§Ø¡",
                    en: "Enter purchase information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø´Ø±Ø§Ø¡ØŒ Ø²ÙŠ Ø±Ù‚Ù… ÙØ§ØªÙˆØ±Ø© Ø§Ù„Ø´Ø±Ø§Ø¡ ÙˆØ§Ù„Ù…Ù†ØªØ¬Ø§Øª ÙˆØ§Ù„ÙƒÙ…ÙŠØ§Øª ÙˆØ¨Ø§Ù‚ÙŠ Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©.",
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
                    ar: "Ø§Ø­ÙØ¸ Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø´Ø±Ø§Ø¡",
                    en: "Save the purchase",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ Ø¨ÙŠØ§Ù†Ø§Øª Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø´Ø±Ø§Ø¡ØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ø¶Ø§ÙØªÙ‡Ø§.",
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
                    ar: "Ø§ÙØªØ­ Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø´Ø±Ø§Ø¡",
                    en: "Find the purchase",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ø§Ù„Ø­ÙØ¸ØŒ Ù‡ØªØ±Ø¬Ø¹ Ù„ØµÙØ­Ø© Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª. Ø¯ÙˆØ± Ø¹Ù„Ù‰ Ø¹Ù…Ù„ÙŠØ© Ø§Ù„Ø´Ø±Ø§Ø¡ Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© ÙÙŠ Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ù…Ø´ØªØ±ÙŠØ§Øª. Ùˆ Ø¥Ù‚Ø¨Ù„Ù‡Ø§.",
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
            ar: "Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø¯ÙˆØ± Ù…Ø®ØµØµ",
            en: "Create your first custom role",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ø¯ÙˆØ± Ù…Ø®ØµØµ Ø¹Ø´Ø§Ù† ØªØ­Ø¯Ø¯ ØµÙ„Ø§Ø­ÙŠØ§Øª Ø§Ù„Ù…ÙˆØ¸ÙÙŠÙ† ÙˆØ¥Ù…ÙƒØ§Ù†ÙŠØ© ÙˆØµÙˆÙ„Ù‡Ù… Ø¯Ø§Ø®Ù„ Ù…Ø¯Ø§Ø±.",
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
                    ar: "Ø§ÙØªØ­ Ø§Ù„Ø£Ø¯ÙˆØ§Ø± ÙˆØ§Ù„ØµÙ„Ø§Ø­ÙŠØ§Øª",
                    en: "Open Roles & Permissions",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„ÙØ±ÙŠÙ‚ Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ø£Ø¯ÙˆØ§Ø± ÙˆØ§Ù„ØµÙ„Ø§Ø­ÙŠØ§Øª.",
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
                    ar: "Ø£Ø¶Ù Ø¯ÙˆØ± Ø¬Ø¯ÙŠØ¯",
                    en: "Add a new role",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ø¯ÙˆØ± Ø¬Ø¯ÙŠØ¯ Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø¯ÙˆØ± Ù…Ø®ØµØµ.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¯ÙˆØ±",
                    en: "Enter role information",
                },
                description: {
                    ar: "Ø§ÙƒØªØ¨ Ø§Ø³Ù… Ø§Ù„Ø¯ÙˆØ± ÙˆÙˆØµÙÙ‡ØŒ ÙˆØ§Ø®ØªØ§Ø± Ø§Ù„ØµÙ„Ø§Ø­ÙŠØ§Øª Ø§Ù„Ù…Ù†Ø§Ø³Ø¨Ø©ØŒ Ø«Ù… Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø¯ÙˆØ±.",
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
            ar: "Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ø¨Ø§Ù‚Ø© Ù…Ù†ØªØ¬Ø§Øª",
            en: "Create your first product bundle",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ø¨Ø§Ù‚Ø© Ù…Ù†ØªØ¬Ø§Øª Ø¹Ø´Ø§Ù† ØªÙ‚Ø¯Ø± ØªØ¬Ù…Ø¹ Ù…Ù†ØªØ¬Ø§ØªÙƒ ÙÙŠ Ø¨Ø§Ù‚Ø© ÙˆØ§Ø­Ø¯Ø© ÙˆØªØ³ØªØ®Ø¯Ù…Ù‡Ø§ ÙÙŠ Ø·Ù„Ø¨Ø§ØªÙƒ.",
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
                    ar: "Ø§ÙØªØ­ Ø¥Ø¶Ø§ÙØ© Ø¨Ø§Ù‚Ø© Ù…Ù†ØªØ¬Ø§Øª",
                    en: "Open Add Product Bundle",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ Ù‚Ø³Ù… Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª Ø«Ù… Ø§Ø®ØªØ± Ø¥Ø¶Ø§ÙØ© Ø¨Ø§Ù‚Ø© Ù…Ù†ØªØ¬Ø§Øª.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¨Ø§Ù‚Ø©",
                    en: "Enter bundle information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¨Ø§Ù‚Ø© Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø©ØŒ ÙˆØ£Ø¶Ù Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ ÙˆØ­Ø¯Ø¯ Ø§Ù„Ù€ SKUs Ø§Ù„Ø®Ø§ØµØ© Ø¨Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª Ø§Ù„Ù…ÙˆØ¬ÙˆØ¯Ø© ÙÙŠ Ø§Ù„Ø¨Ø§Ù‚Ø©.",
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
                    ar: "Ø§Ø­ÙØ¸ Ø§Ù„Ø¨Ø§Ù‚Ø©",
                    en: "Save the bundle",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¨Ø§Ù‚Ø© ÙˆØªØ­Ø¯Ø¯ Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª ÙˆØ§Ù„Ù€ SKUsØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø¨Ø§Ù‚Ø©.",
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
            ar: "Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ù‚Ø§Ø¹Ø¯Ø© Ø£ØªÙ…ØªØ© Ù„ØªÙˆØ²ÙŠØ¹ Ø§Ù„Ø·Ù„Ø¨Ø§Øª",
            en: "Create your first order assignment automation rule",
        },

        description: {
            ar: "Ø£Ù†Ø´Ø¦ Ø£ÙˆÙ„ Ù‚Ø§Ø¹Ø¯Ø© Ø£ØªÙ…ØªØ© Ù„ØªÙˆØ²ÙŠØ¹ Ø§Ù„Ø·Ù„Ø¨Ø§Øª Ø¹Ø´Ø§Ù† ØªØ³Ø§Ø¹Ø¯Ùƒ ÙÙŠ ØªÙˆØ²ÙŠØ¹ Ø§Ù„Ø·Ù„Ø¨Ø§Øª ØªÙ„Ù‚Ø§Ø¦ÙŠÙ‹Ø§ Ø¹Ù„Ù‰ ÙØ±ÙŠÙ‚ Ø§Ù„Ø¹Ù…Ù„.",
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
                    ar: "Ø§ÙØªØ­ Ø§Ù„ÙƒÙˆÙ„ Ø³Ù†ØªØ±",
                    en: "Open Call Center",
                },
                description: {
                    ar: "Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¬Ø§Ù†Ø¨ÙŠØ©ØŒ Ø§ÙØªØ­ ØµÙØ­Ø© Ø§Ù„ÙƒÙˆÙ„ Ø³Ù†ØªØ±.",
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
                    ar: "Ø£Ù†Ø´Ø¦ Ù‚Ø§Ø¹Ø¯Ø© Ø£ØªÙ…ØªØ©",
                    en: "Create an automation rule",
                },
                description: {
                    ar: "Ø§Ø¶ØºØ· Ø¹Ù„Ù‰ Ø¥Ù†Ø´Ø§Ø¡ Ù‚Ø§Ø¹Ø¯Ø© Ø£ØªÙ…ØªØ© Ø¹Ø´Ø§Ù† ØªØ¨Ø¯Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙˆÙ„ Ù‚Ø§Ø¹Ø¯Ø© Ù„ØªÙˆØ²ÙŠØ¹ Ø§Ù„Ø·Ù„Ø¨Ø§Øª.",
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
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø£ØªÙ…ØªØ©",
                    en: "Enter the automation rule information",
                },
                description: {
                    ar: "Ø£Ø¯Ø®Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø£ØªÙ…ØªØ© ÙˆØ§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© Ù„ØªØ­Ø¯ÙŠØ¯ Ø·Ø±ÙŠÙ‚Ø© ØªÙˆØ²ÙŠØ¹ Ø§Ù„Ø·Ù„Ø¨Ø§Øª.",
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
                    ar: "Ø§Ø­ÙØ¸ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø£ØªÙ…ØªØ©",
                    en: "Save the automation rule",
                },
                description: {
                    ar: "Ø¨Ø¹Ø¯ Ù…Ø§ ØªØ®Ù„Øµ Ø¥Ø¹Ø¯Ø§Ø¯ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø£ØªÙ…ØªØ©ØŒ Ø§Ø¶ØºØ· Ø­ÙØ¸ Ù„Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù‚Ø§Ø¹Ø¯Ø©.",
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
    console.log('ðŸŒ± Seeding getting started checklist items and steps...');

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
            groupNumber: checklistItem.groupNumber ?? 2,
            isActive: true,
        });
        const savedItem = await itemRepo.save(itemEntity);
        itemByKey.set(checklistItem.key, savedItem);

        const existingSteps = await stepRepo.find({ where: { itemId: savedItem.id } });
        const stepByKey = new Map(existingSteps.map((step) => [step.key, step]));
        const definedStepKeys = new Set(checklistItem.steps.map((step) => step.key));

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

        // Remove steps that were seeded before but are no longer defined in this file.
        const staleSteps = existingSteps.filter((step) => !definedStepKeys.has(step.key));
        if (staleSteps.length > 0) {
            await stepRepo.remove(staleSteps);
            console.log(`ðŸ—‘ï¸  Removed ${staleSteps.length} stale step(s) from checklist item "${checklistItem.key}"`);
        }
    }

    // Remove items that were seeded before but are no longer defined in this file
    // (their steps are cascade-deleted by the database).
    const definedItemKeys = new Set(gettingStartedChecklist.map((item) => item.key));
    const staleItems = existingItems.filter((item) => !definedItemKeys.has(item.key));
    if (staleItems.length > 0) {
        await itemRepo.remove(staleItems);
        console.log(`ðŸ—‘ï¸  Removed ${staleItems.length} stale getting started checklist item(s)`);
    }

    console.log(`âœ… Seeded ${gettingStartedChecklist.length} getting started checklist items`);
}
export const AI_MODEL_SEEDS = [
    {
        "provider": "anthropic",
        "modelCode": "claude-3-haiku",
        "name": "Claude 3 Haiku",
        "description": "Claude 3 Haiku is Anthropic's fastest and most compact model for\nnear-instant responsiveness. Quick and accurate targeted performance.\n\nSee the launch announcement and benchmark results [here](https://www.anthropic.com/news/claude-3-haiku)\n\n#multimodal",
        "descriptionAr": "كود 3 هايكو هو أسرع وأصغر نموذج من أنثروبك لاستجابة سريعة جداً. أداء مستهدف سريع ودقيق. انظر الإعلان الرسمي ونتائج المعايير [هنا](https://www.anthropic.com/news/claude-3-haiku). #متعدد_الوسائط",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-3-haiku",
            "canonicalSlug": "anthropic/claude-3-haiku",
            "supportedParameters": [
                "max_tokens",
                "stop",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.00000125",
                "web_search": "0.01",
                "input_cache_read": "0.00000003",
                "input_cache_write": "0.0000003",
                "input_cache_write_1h": "0.0000005"
            },
            "created": 1710288000,
            "knowledgeCutoff": "2023-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-fable-5",
        "name": "Claude Fable 5",
        "description": "Claude Fable 5 is a Mythos-class model from Anthropic, built for autonomous knowledge work and coding. It supports text, image, and file inputs with text output, with reasoning support and...",
        "descriptionAr": "كود فايبل 5 هو نموذج من فئة ميثوس من أنثروبك، مبني للعمل المعرفي المستقل والبرمجة. يدعم مدخلات النص والصورة والملفات مع مخرجات نصية، مع دعم التفكير و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-fable-5",
            "canonicalSlug": "anthropic/claude-5-fable-20260609",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00005",
                "web_search": "0.01",
                "input_cache_read": "0.000001",
                "input_cache_write": "0.0000125",
                "input_cache_write_1h": "0.00002"
            },
            "created": 1781007515,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5",
        "description": "Claude Haiku 4.5 is Anthropicâ€™s fastest and most efficient model, delivering near-frontier intelligence at a fraction of the cost and latency of larger Claude models. Matching Claude Sonnet 4â€™s performance...",
        "descriptionAr": "كود هايكو 4.5 هو أسرع وأكثر كفاءة نماذج أنثروبك، يقدم ذكاءً قريباً من الحدود العليا بتكلفة وكمون جزء من نماذج كود الأكبر. يطابق أداء كود سونيت 4...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 64000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-haiku-4.5",
            "canonicalSlug": "anthropic/claude-4.5-haiku-20251001",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000001",
                "completion": "0.000005",
                "web_search": "0.01",
                "input_cache_read": "0.0000001",
                "input_cache_write": "0.00000125",
                "input_cache_write_1h": "0.000002"
            },
            "created": 1760547638,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4",
        "name": "Claude Opus 4",
        "description": "Claude Opus 4 is benchmarked as the worldâ€™s best coding model, at time of release, bringing sustained performance on complex, long-running tasks and agent workflows. It sets new benchmarks in...",
        "descriptionAr": "تم تصنيف كود أوبوس 4 كأفضل نموذج برمجة في العالم عند إصداره، يقدم أداءً مستداماً في المهام المعقدة طويلة الأمد وسير عمل الوكلاء. يضع معايير جديدة في...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 32000
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4",
            "canonicalSlug": "anthropic/claude-4-opus-20250522",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "stop",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000015",
                "completion": "0.000075",
                "web_search": "0.01",
                "input_cache_read": "0.0000015",
                "input_cache_write": "0.00001875",
                "input_cache_write_1h": "0.00003"
            },
            "created": 1747931245,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.1",
        "name": "Claude Opus 4.1",
        "description": "Claude Opus 4.1 is an updated version of Anthropicâ€™s flagship model, offering improved performance in coding, reasoning, and agentic tasks. It achieves 74.5% on SWE-bench Verified and shows notable gains...",
        "descriptionAr": "كود أوبوس 4.1 هو نسخة محدثة من النموذج الرائد لشركة أنثروبك، يوفر أداءً محسناً في البرمجة والاستدلال والمهام الوكيلة. يحقق 74.5% في اختبار SWE-bench Verified ويظهر مكاسب ملحوظة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 32000
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.1",
            "canonicalSlug": "anthropic/claude-4.1-opus-20250805",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "stop",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000015",
                "completion": "0.000075",
                "web_search": "0.01",
                "input_cache_read": "0.0000015",
                "input_cache_write": "0.00001875",
                "input_cache_write_1h": "0.00003"
            },
            "created": 1754411591,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.5",
        "name": "Claude Opus 4.5",
        "description": "Claude Opus 4.5 is Anthropicâ€™s frontier reasoning model optimized for complex software engineering, agentic workflows, and long-horizon computer use. It offers strong multimodal capabilities, competitive performance across real-world coding and...",
        "descriptionAr": "كود أوبوس 4.5 هو نموذج الاستدلال الحدودي من أنثروبك، محسّن للهندسة البرمجية المعقدة وسير العمل الوكيل واستخدام الكمبيوتر طويل الأمد. يوفر قدرات متعددة الوسائط قوية، وأداءً تنافسياً عبر البرمجة الواقعية و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 64000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.5",
            "canonicalSlug": "anthropic/claude-4.5-opus-20251124",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000025",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "input_cache_write": "0.00000625",
                "input_cache_write_1h": "0.00001"
            },
            "created": 1764010580,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.6",
        "name": "Claude Opus 4.6",
        "description": "Opus 4.6 is Anthropicâ€™s strongest model for coding and long-running professional tasks. It is built for agents that operate across entire workflows rather than single prompts, making it especially effective...",
        "descriptionAr": "أوبوس 4.6 هو أقوى نموذج من أنثروبك للبرمجة والمهام المهنية طويلة التشغيل. مبني للوكلاء الذين يعملون عبر سير العمل الكاملة بدلاً من المطالبات المنفردة، مما يجعله فعالاً بشكل خاص...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.6",
            "canonicalSlug": "anthropic/claude-4.6-opus-20260205",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000025",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "input_cache_write": "0.00000625",
                "input_cache_write_1h": "0.00001"
            },
            "created": 1770219050,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.7",
        "name": "Claude Opus 4.7",
        "description": "Opus 4.7 is the next generation of Anthropic's Opus family, built for long-running, asynchronous agents. Building on the coding and agentic strengths of Opus 4.6, it delivers stronger performance on...",
        "descriptionAr": "أوبوس 4.7 هو الجيل التالي من عائلة أوبوس من أنثروبك، مبني للوكلاء غير المتزامنين طويلي التشغيل. بناءً على نقاط القوة في البرمجة والوكالة من أوبوس 4.6، يقدم أداءً أقوى على...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.7",
            "canonicalSlug": "anthropic/claude-4.7-opus-20260416",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000025",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "input_cache_write": "0.00000625",
                "input_cache_write_1h": "0.00001"
            },
            "created": 1776351100,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.7-fast",
        "name": "Claude Opus 4.7 (Fast)",
        "description": "Fast-mode variant of [Opus 4.7](/anthropic/claude-opus-4.7) - identical capabilities with higher output speed at premium 6x pricing.\n\nLearn more in Anthropic's docs: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "descriptionAr": "نسخة الوضع السريع من [أوبوس 4.7](/anthropic/claude-opus-4.7) - قدرات متطابقة مع سرعة إخراج أعلى بتسعير ممتاز 6 أضعاف. تعلم المزيد في وثائق أنثروبك: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.7-fast",
            "canonicalSlug": "anthropic/claude-4.7-opus-fast-20260512",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.00003",
                "completion": "0.00015",
                "web_search": "0.01",
                "input_cache_read": "0.000003",
                "input_cache_write": "0.0000375",
                "input_cache_write_1h": "0.00006"
            },
            "created": 1778613011,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "description": "Claude Opus 4.8 is Anthropic's most capable generally available model in the Opus family. It supports text, image, and file inputs with text output, with reasoning support and a 1M-token...",
        "descriptionAr": "كود أوبوس 4.8 هو أكثر نماذج عائلة أوبوس من أنثروبك قدرةً المتاحة عموماً. يدعم مدخلات النص والصورة والملفات مع مخرجات نصية، مع دعم التفكير ونافذة سياق بـ 1 مليون رموز...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.8",
            "canonicalSlug": "anthropic/claude-4.8-opus-20260528",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000025",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "input_cache_write": "0.00000625",
                "input_cache_write_1h": "0.00001"
            },
            "created": 1779905091,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-4.8-fast",
        "name": "Claude Opus 4.8 (Fast)",
        "description": "Fast-mode variant of [Opus 4.8](/anthropic/claude-opus-4.8) - identical capabilities with higher output speed at 2x pricing relative to regular Opus 4.8.\n\nLearn more in Anthropic's docs: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "descriptionAr": "نسخة الوضع السريع من [أوبوس 4.8](/anthropic/claude-opus-4.8) - قدرات متطابقة مع سرعة إخراج أعلى بتسعير 2 أضعاف مقارنة بأوبوس 4.8 العادي. تعلم المزيد في وثائق أنثروبك: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-4.8-fast",
            "canonicalSlug": "anthropic/claude-4.8-opus-fast-20260528",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00005",
                "web_search": "0.01",
                "input_cache_read": "0.000001",
                "input_cache_write": "0.0000125",
                "input_cache_write_1h": "0.00002"
            },
            "created": 1779913703,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-sonnet-4",
        "name": "Claude Sonnet 4",
        "description": "Claude Sonnet 4 significantly enhances the capabilities of its predecessor, Sonnet 3.7, excelling in both coding and reasoning tasks with improved precision and controllability. Achieving state-of-the-art performance on SWE-bench (72.7%),...",
        "descriptionAr": "يعزز كود سونيت 4 قدرات سابقه سونيت 3.7 بشكل كبير، ويتفوق في كل من مهام البرمجة والاستدلال بدقة وتحكم محسنين. يحقق أداءً متطوراً في SWE-bench (72.7%)،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 64000
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-sonnet-4",
            "canonicalSlug": "anthropic/claude-4-sonnet-20250522",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "stop",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.0000003",
                "input_cache_write": "0.00000375",
                "input_cache_write_1h": "0.000006",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.000006",
                        "completion": "0.0000225",
                        "input_cache_read": "0.0000006",
                        "input_cache_write": "0.0000075",
                        "input_cache_write_1h": "0.000012"
                    }
                ]
            },
            "created": 1747930371,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5",
        "description": "Claude Sonnet 4.5 is Anthropicâ€™s most advanced Sonnet model to date, optimized for real-world agents and coding workflows. It delivers state-of-the-art performance on coding benchmarks such as SWE-bench Verified, with...",
        "descriptionAr": "كود سونيت 4.5 هو أكثر نماذج سونيت تقدماً من أنثروبك حتى الآن، محسّن للوكلاء الواقعيين وسير عمل البرمجة. يقدم أداءً متطوراً في معايير البرمجة مثل SWE-bench Verified، مع...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 64000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-sonnet-4.5",
            "canonicalSlug": "anthropic/claude-4.5-sonnet-20250929",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.0000003",
                "input_cache_write": "0.00000375",
                "input_cache_write_1h": "0.000006",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.000006",
                        "completion": "0.0000225",
                        "input_cache_read": "0.0000006",
                        "input_cache_write": "0.0000075",
                        "input_cache_write_1h": "0.000012"
                    }
                ]
            },
            "created": 1759161676,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "description": "Sonnet 4.6 is Anthropic's most capable Sonnet-class model yet, with frontier performance across coding, agents, and professional work. It excels at iterative development, complex codebase navigation, end-to-end project management with...",
        "descriptionAr": "سونيت 4.6 هو أكثر نماذج فئة سونيت من أنثروبك قدرةً حتى الآن، بأداء حدودي عبر البرمجة والوكلاء والعمل المهني. يمتاز بالتطوير التكراري، والتنقل في قواعد الكود المعقدة، وإدارة المشاريع الشاملة مع...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-sonnet-4.6",
            "canonicalSlug": "anthropic/claude-4.6-sonnet-20260217",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.0000003",
                "input_cache_write": "0.00000375",
                "input_cache_write_1h": "0.000006"
            },
            "created": 1771342990,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "description": "Sonnet 5 is Anthropic's most capable Sonnet-class model, with frontier performance across coding, agents, and professional work. It supports adaptive thinking with selectable reasoning effort levels (low, medium, high, max,...",
        "descriptionAr": "سونيت 5 هو أكثر نماذج فئة سونيت من أنثروبك قدرةً، بأداء حدودي عبر البرمجة والوكلاء والعمل المهني. يدعم التفكير التكيفي مع مستويات جهد استدلال قابلة للاختيار (منخفض، متوسط، عالي، أقصى،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-sonnet-5",
            "canonicalSlug": "anthropic/claude-sonnet-5-20260630",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.00001",
                "web_search": "0.01",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.0000025",
                "input_cache_write_1h": "0.000004"
            },
            "created": 1782843083,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-5",
        "name": "Claude Opus 5",
        "description": "Claude Opus 5 is Anthropicâ€™s flagship model for demanding reasoning, coding, and long-horizon agentic work. It is particularly strong at end-to-end software tasks, code review and bug finding, visual analysis...",
        "descriptionAr": "كود أوبوس 5 هو النموذج الرائد من أنثروبك للاستدلال والبرمجة والعمل الوكيل طويل الأمد المتطلب. قوي بشكل خاص في المهام البرمجية الشاملة، ومراجعة الكود والعثور على الأخطاء، والتحليل البصري...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-5",
            "canonicalSlug": "anthropic/claude-opus-5-20260723",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000025",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "input_cache_write": "0.00000625",
                "input_cache_write_1h": "0.00001"
            },
            "created": 1784912544,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "anthropic",
        "modelCode": "claude-opus-5-fast",
        "name": "Claude Opus 5 (Fast)",
        "description": "Fast-mode variant of [Opus 5](/anthropic/claude-opus-5) - identical capabilities with higher output speed at 2x pricing relative to regular Opus 5.\n\nLearn more in Anthropic's docs: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "descriptionAr": "نسخة الوضع السريع من [أوبوس 5](/anthropic/claude-opus-5) - قدرات متطابقة مع سرعة إخراج أعلى بتسعير 2 أضعاف مقارنة بأوبوس 5 العادي. تعلم المزيد في وثائق أنثروبك: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1000000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "anthropic/claude-opus-5-fast",
            "canonicalSlug": "anthropic/claude-opus-5-fast-20260723",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "stop",
                "structured_outputs",
                "tool_choice",
                "tools",
                "verbosity"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00005",
                "web_search": "0.01",
                "input_cache_read": "0.000001",
                "input_cache_write": "0.0000125",
                "input_cache_write_1h": "0.00002"
            },
            "created": 1784912546,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-chat",
        "name": "DeepSeek V3",
        "description": "DeepSeek-V3 is the latest model from the DeepSeek team, building upon the instruction following and coding abilities of the previous versions. Pre-trained on nearly 15 trillion tokens, the reported evaluations...",
        "descriptionAr": "ديبسيك-V3 هو أحدث نموذج من فريق ديبسيك، يبنى على اتباع التعليمات وقدرات البرمجة من الإصدارات السابقة. تم التدريب المسبق على ما يقرب من 15 تريليون رمز، والتقييمات المبلغ عنها...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 16000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-chat",
            "canonicalSlug": "deepseek/deepseek-chat-v3",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000002574",
                "completion": "0.0000010287"
            },
            "created": 1735241320,
            "knowledgeCutoff": "2024-07-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-chat-v3-0324",
        "name": "DeepSeek V3 0324",
        "description": "DeepSeek V3, a 685B-parameter, mixture-of-experts model, is the latest iteration of the flagship chat model family from the DeepSeek team. It succeeds the [DeepSeek V3](/deepseek/deepseek-chat-v3) model and performs really well...",
        "descriptionAr": "ديبسيك V3، نموذج مزيج من الخبراء (MoE) بمعامل 685 مليار، هو التكرار الأحدث من عائلة نماذج الدردشة الرائدة من فريق ديبسيك. يخلف نموذج [ديبسيك V3](/deepseek/deepseek-chat-v3) ويعمل بشكل جيد جداً...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-chat-v3-0324",
            "canonicalSlug": "deepseek/deepseek-chat-v3-0324",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000027",
                "completion": "0.00000112",
                "input_cache_read": "0.000000135"
            },
            "created": 1742824755,
            "knowledgeCutoff": "2024-07-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-chat-v3.1",
        "name": "DeepSeek V3.1",
        "description": "DeepSeek-V3.1 is a large hybrid reasoning model (671B parameters, 37B active) that supports both thinking and non-thinking modes via prompt templates. It extends the DeepSeek-V3 base with a two-phase long-context...",
        "descriptionAr": "ديبسيك-V3.1 هو نموذج استدلال هجين كبير (671 مليار معامل، 37 مليار نشط) يدعم كلاً من وضعي التفكير وغير التفكير عبر قوالب المطالبة. يمد أساس ديبسيك-V3 بسياق طويل من مرحلتين...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-chat-v3.1",
            "canonicalSlug": "deepseek/deepseek-chat-v3.1",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.00000095",
                "input_cache_read": "0.00000013"
            },
            "created": 1755779628,
            "knowledgeCutoff": "2025-03-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v3.1-terminus",
        "name": "DeepSeek V3.1 Terminus",
        "description": "DeepSeek-V3.1 Terminus is an update to [DeepSeek V3.1](/deepseek/deepseek-chat-v3.1) that maintains the model's original capabilities while addressing issues reported by users, including language consistency and agent capabilities, further optimizing the model's...",
        "descriptionAr": "ديبسيك-V3.1 تيرمينوس هو تحديث لـ [ديبسيك V3.1](/deepseek/deepseek-chat-v3.1) يحافظ على القدرات الأصلية للنموذج بينما يعالج المشكلات التي أبلغ عنها المستخدمون، بما في ذلك اتساق اللغة وقدرات الوكيل، مما يحسن أكثر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 163840
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v3.1-terminus",
            "canonicalSlug": "deepseek/deepseek-v3.1-terminus",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000027",
                "completion": "0.000001"
            },
            "created": 1758548275,
            "knowledgeCutoff": "2025-03-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "description": "DeepSeek-V3.2 is a large language model designed to harmonize high computational efficiency with strong reasoning and agentic tool-use performance. It introduces DeepSeek Sparse Attention (DSA), a fine-grained sparse attention mechanism...",
        "descriptionAr": "ديبسيك-V3.2 هو نموذج لغوي كبير مصمم لتنسيق الكفاءة الحسابية العالية مع أداء قوي في الاستدلال واستخدام الأدوات الوكيلة. يقدم انتباه ديبسيك المتناثر (DSA)، آلية انتباه متناثرة دقيقة الحبيبات...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v3.2",
            "canonicalSlug": "deepseek/deepseek-v3.2-20251201",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000000269",
                "completion": "0.0000004",
                "input_cache_read": "0.0000001345"
            },
            "created": 1764594642,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v3.2-exp",
        "name": "DeepSeek V3.2 Exp",
        "description": "DeepSeek-V3.2-Exp is an experimental large language model released by DeepSeek as an intermediate step between V3.1 and future architectures. It introduces DeepSeek Sparse Attention (DSA), a fine-grained sparse attention mechanism...",
        "descriptionAr": "ديبسيك-V3.2-Exp هو نموذج لغوي كبير تجريبي أصدره ديبسيك كخطوة وسيطة بين V3.1 والبنيات المستقبلية. يقدم انتباه ديبسيك المتناثر (DSA)، آلية انتباه متناثرة دقيقة الحبيبات...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v3.2-exp",
            "canonicalSlug": "deepseek/deepseek-v3.2-exp",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000027",
                "completion": "0.00000041"
            },
            "created": 1759150481,
            "knowledgeCutoff": "2025-07-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash 0423",
        "description": "DeepSeek V4 Flash is an efficiency-optimized Mixture-of-Experts model from DeepSeek with 284B total parameters and 13B activated parameters, supporting a 1M-token context window. It is designed for fast inference and...",
        "descriptionAr": "ديبسيك V4 فلاش هو نموذج مزيج الخبراء المحسن للكفاءة من ديبسيك بإجمالي 284 مليار معامل و13 مليار معامل مفعل، يدعم نافذة سياق بـ 1 مليون رمز. مصمم للاستدلال السريع و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 384000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v4-flash",
            "canonicalSlug": "deepseek/deepseek-v4-flash-20260423",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_a",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000000826",
                "completion": "0.0000001652",
                "input_cache_read": "0.00000001652"
            },
            "created": 1777000666,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "description": "DeepSeek V4 Flash 0731 is a sparse mixture-of-experts model from DeepSeek, with 13B active parameters out of 284B total. This re-post-trained revision is suited for coding, reasoning, and agent workflows....",
        "descriptionAr": "ديبسيك V4 فلاش 0731 هو نموذج مزيج خبراء متناثر من ديبسيك، بـ 13 مليار معامل نشط من إجمالي 284 مليار. هذه النسخة المعاد تدريبها بعد النشر مناسبة للبرمجة والاستدلال وسير عمل الوكيل....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 1310720,
            "maxOutputTokens": 393216
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v4-flash-0731",
            "canonicalSlug": "deepseek/deepseek-v4-flash-20260731",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "parallel_tool_calls",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_a",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000014",
                "completion": "0.00000028",
                "input_cache_read": "0.000000028"
            },
            "created": 1785478908,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro 0423",
        "description": "DeepSeek V4 Pro is a large-scale Mixture-of-Experts model from DeepSeek with 1.6T total parameters and 49B activated parameters, supporting a 1M-token context window. It is designed for advanced reasoning, coding,...",
        "descriptionAr": "ديبسيك V4 برو هو نموذج مزيج خبراء واسع النطاق من ديبسيك بـ 1.6 تريليون معامل إجمالي و49 مليار معامل مفعل، يدعم نافذة سياق بـ 1 مليون رمز. مصمم للاستدلال المتقدم، والبرمجة،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 384000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v4-pro",
            "canonicalSlug": "deepseek/deepseek-v4-pro-20260423",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000066",
                "completion": "0.00000198",
                "input_cache_read": "0.000000022",
                "overrides": [
                    {
                        "utc_start": 1000,
                        "utc_end": 100,
                        "prompt": "0.00000066",
                        "completion": "0.00000198",
                        "input_cache_read": "0.000000022"
                    },
                    {
                        "utc_start": 100,
                        "utc_end": 400,
                        "prompt": "0.00000132",
                        "completion": "0.00000396",
                        "input_cache_read": "0.000000044"
                    },
                    {
                        "utc_start": 400,
                        "utc_end": 600,
                        "prompt": "0.00000066",
                        "completion": "0.00000198",
                        "input_cache_read": "0.000000022"
                    },
                    {
                        "utc_start": 600,
                        "utc_end": 1000,
                        "prompt": "0.00000132",
                        "completion": "0.00000396",
                        "input_cache_read": "0.000000044"
                    }
                ]
            },
            "created": 1777000679,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "description": "DeepSeek V4 Pro 0813 is a large-scale mixture-of-experts model from DeepSeek. This is the GA release of DeepSeek V4 Pro.",
        "descriptionAr": "ديبسيك V4 برو 0813 هو نموذج مزيج خبراء واسع النطاق من ديبسيك. هذا هو الإصدار المتاح عموماً (GA) من ديبسيك V4 برو.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 384000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-v4-pro-0813",
            "canonicalSlug": "deepseek/deepseek-v4-pro-20260813",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000066",
                "completion": "0.00000198",
                "input_cache_read": "0.000000022",
                "overrides": [
                    {
                        "utc_start": 1000,
                        "utc_end": 100,
                        "prompt": "0.00000066",
                        "completion": "0.00000198",
                        "input_cache_read": "0.000000022"
                    },
                    {
                        "utc_start": 100,
                        "utc_end": 400,
                        "prompt": "0.00000132",
                        "completion": "0.00000396",
                        "input_cache_read": "0.000000044"
                    },
                    {
                        "utc_start": 400,
                        "utc_end": 600,
                        "prompt": "0.00000066",
                        "completion": "0.00000198",
                        "input_cache_read": "0.000000022"
                    },
                    {
                        "utc_start": 600,
                        "utc_end": 1000,
                        "prompt": "0.00000132",
                        "completion": "0.00000396",
                        "input_cache_read": "0.000000044"
                    }
                ]
            },
            "created": 1786549364,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-r1",
        "name": "R1",
        "description": "DeepSeek R1 is here: Performance on par with [OpenAI o1](/openai/o1), but open-sourced and with fully open reasoning tokens. It's 671B parameters in size, with 37B active in an inference pass....",
        "descriptionAr": "ديبسيك R1 هنا: أداء مماثل لـ [أوبن إي آي o1](/openai/o1)، ولكنه مفتوح المصدر برموز استدلال مفتوحة تماماً. حجمه 671 مليار معامل، مع 37 مليار نشط في تمرير الاستدلال....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 64000,
            "maxOutputTokens": 16000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-r1",
            "canonicalSlug": "deepseek/deepseek-r1",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000007",
                "completion": "0.0000025"
            },
            "created": 1737381095,
            "knowledgeCutoff": "2024-07-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-r1-0528",
        "name": "R1 0528",
        "description": "May 28th update to the [original DeepSeek R1](/deepseek/deepseek-r1) Performance on par with [OpenAI o1](/openai/o1), but open-sourced and with fully open reasoning tokens. It's 671B parameters in size, with 37B active...",
        "descriptionAr": "تحديث 28 مايو لـ [ديبسيك R1 الأصلي](/deepseek/deepseek-r1). أداء مماثل لـ [أوبن إي آي o1](/openai/o1)، ولكنه مفتوح المصدر برموز استدلال مفتوحة تماماً. حجمه 671 مليار معامل، مع 37 مليار نشط...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 163840,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "deepseek/deepseek-r1-0528",
            "canonicalSlug": "deepseek/deepseek-r1-0528",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000005",
                "completion": "0.00000215",
                "input_cache_read": "0.00000035"
            },
            "created": 1748455170,
            "knowledgeCutoff": "2025-03-31",
            "expirationDate": null
        }
    },
    {
        "provider": "deepseek",
        "modelCode": "deepseek-r1-distill-llama-70b",
        "name": "R1 Distill Llama 70B",
        "description": "DeepSeek R1 Distill Llama 70B is a distilled large language model based on [Llama-3.3-70B-Instruct](/meta-llama/llama-3.3-70b-instruct), using outputs from [DeepSeek R1](/deepseek/deepseek-r1). The model combines advanced distillation techniques to achieve high performance across...",
        "descriptionAr": "ديبسيك R1 دستيل لاما 70B هو نموذج لغوي كبير دستيل مبني على [لاما-3.3-70B-إنستراكت](/meta-llama/llama-3.3-70b-instruct)، باستخدام مخرجات من [ديبسيك R1](/deepseek/deepseek-r1). يجمع النموذج تقنيات التقطير المتقدمة لتحقيق أداء عالي عبر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 8192,
            "maxOutputTokens": 8192
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "deepseek/deepseek-r1-distill-llama-70b",
            "canonicalSlug": "deepseek/deepseek-r1-distill-llama-70b",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "seed",
                "stop",
                "temperature",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000008",
                "completion": "0.0000008"
            },
            "created": 1737663169,
            "knowledgeCutoff": "2024-07-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "description": "Gemini 2.5 Flash is Google's state-of-the-art workhorse model, specifically designed for advanced reasoning, coding, mathematics, and scientific tasks. It includes built-in \"thinking\" capabilities, enabling it to provide responses with greater...",
        "descriptionAr": "جيميني 2.5 فلاش هو نموذج العمل المتطور من جوجل، مصمم خصيصاً للاستدلال المتقدم والبرمجة والرياضيات والمهام العلمية. يتضمن قدرات \"تفكير\" مدمجة، تمكنه من تقديم استجابات بمزيد من...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text",
                "audio",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65535
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-2.5-flash",
            "canonicalSlug": "google/gemini-2.5-flash",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000003",
                "completion": "0.0000025",
                "image": "0.0000003",
                "audio": "0.000001",
                "input_audio_cache": "0.0000001",
                "web_search": "0.014",
                "internal_reasoning": "0.0000025",
                "input_cache_read": "0.00000003",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1750172488,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite",
        "description": "Gemini 2.5 Flash-Lite is a lightweight reasoning model in the Gemini 2.5 family, optimized for ultra-low latency and cost efficiency. It offers improved throughput, faster token generation, and better performance...",
        "descriptionAr": "جيميني 2.5 فلاش-لايت هو نموذج استدلال خفيف في عائلة جيميني 2.5، محسّن لكمون فائق الانخفاض وكفاءة التكلفة. يوفر معدل نقل بيانات محسن، وتوليد رموز أسرع، وأداء أفضل...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file",
                "audio",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65535
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-2.5-flash-lite",
            "canonicalSlug": "google/gemini-2.5-flash-lite",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000001",
                "completion": "0.0000004",
                "image": "0.0000001",
                "audio": "0.0000003",
                "input_audio_cache": "0.00000003",
                "web_search": "0.014",
                "internal_reasoning": "0.0000004",
                "input_cache_read": "0.00000001",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1753200276,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "description": "Gemini 2.5 Pro is Googleâ€™s state-of-the-art AI model designed for advanced reasoning, coding, mathematics, and scientific tasks. It employs â€œthinkingâ€ capabilities, enabling it to reason through responses with enhanced accuracy...",
        "descriptionAr": "جيميني 2.5 برو هو نموذج الذكاء الاصطناعي المتطور من جوجل، مصمم للاستدلال المتقدم والبرمجة والرياضيات والمهام العلمية. يستخدم قدرات \"التفكير\"، تمكنه من الاستدلال عبر الاستجابات بدقة معززة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file",
                "audio",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-2.5-pro",
            "canonicalSlug": "google/gemini-2.5-pro",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "image": "0.00000125",
                "audio": "0.00000125",
                "input_audio_cache": "0.000000125",
                "web_search": "0.014",
                "internal_reasoning": "0.00001",
                "input_cache_read": "0.000000125",
                "input_cache_write": "0.000000375",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.0000025",
                        "completion": "0.000015",
                        "audio": "0.0000025",
                        "input_audio_cache": "0.00000025",
                        "input_cache_read": "0.00000025"
                    }
                ]
            },
            "created": 1750169544,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-pro-preview-05-06",
        "name": "Gemini 2.5 Pro Preview 05-06",
        "description": "Gemini 2.5 Pro is Googleâ€™s state-of-the-art AI model designed for advanced reasoning, coding, mathematics, and scientific tasks. It employs â€œthinkingâ€ capabilities, enabling it to reason through responses with enhanced accuracy...",
        "descriptionAr": "جيميني 2.5 برو هو نموذج الذكاء الاصطناعي المتطور من جوجل، مصمم للاستدلال المتقدم والبرمجة والرياضيات والمهام العلمية. يستخدم قدرات \"التفكير\"، تمكنه من الاستدلال عبر الاستجابات بدقة معززة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file",
                "audio",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65535
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-2.5-pro-preview-05-06",
            "canonicalSlug": "google/gemini-2.5-pro-preview-03-25",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "image": "0.00000125",
                "audio": "0.00000125",
                "input_audio_cache": "0.000000125",
                "web_search": "0.014",
                "internal_reasoning": "0.00001",
                "input_cache_read": "0.000000125",
                "input_cache_write": "0.000000375",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.0000025",
                        "completion": "0.000015",
                        "audio": "0.0000025",
                        "input_audio_cache": "0.00000025",
                        "input_cache_read": "0.00000025"
                    }
                ]
            },
            "created": 1746578513,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-pro-preview",
        "name": "Gemini 2.5 Pro Preview 06-05",
        "description": "Gemini 2.5 Pro is Googleâ€™s state-of-the-art AI model designed for advanced reasoning, coding, mathematics, and scientific tasks. It employs â€œthinkingâ€ capabilities, enabling it to reason through responses with enhanced accuracy...",
        "descriptionAr": "جيميني 2.5 برو هو نموذج الذكاء الاصطناعي المتطور من جوجل، مصمم للاستدلال المتقدم والبرمجة والرياضيات والمهام العلمية. يستخدم قدرات \"التفكير\"، تمكنه من الاستدلال عبر الاستجابات بدقة معززة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-2.5-pro-preview",
            "canonicalSlug": "google/gemini-2.5-pro-preview-06-05",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "image": "0.00000125",
                "audio": "0.00000125",
                "input_audio_cache": "0.000000125",
                "web_search": "0.014",
                "internal_reasoning": "0.00001",
                "input_cache_read": "0.000000125",
                "input_cache_write": "0.000000375",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.0000025",
                        "completion": "0.000015",
                        "audio": "0.0000025",
                        "input_audio_cache": "0.00000025",
                        "input_cache_read": "0.00000025"
                    }
                ]
            },
            "created": 1749137257,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview",
        "description": "Gemini 3 Flash Preview is a high speed, high value thinking model designed for agentic workflows, multi turn chat, and coding assistance. It delivers near Pro level reasoning and tool...",
        "descriptionAr": "جيميني 3 فلاش معاينة هو نموذج تفكير عالي السرعة والقيمة مصمم لسير العمل الوكيل، والمحادثة متعددة الدورات، ومساعدة البرمجة. يقدم استدلالاً قريباً من مستوى برو وأدوات...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file",
                "audio",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3-flash-preview",
            "canonicalSlug": "google/gemini-3-flash-preview-20251217",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000005",
                "completion": "0.000003",
                "image": "0.0000005",
                "audio": "0.000001",
                "input_audio_cache": "0.0000001",
                "web_search": "0.014",
                "internal_reasoning": "0.000003",
                "input_cache_read": "0.00000005",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1765987078,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "description": "Gemini 3.1 Flash Lite is Googleâ€™s GA high-efficiency multimodal model optimized for low-latency, high-volume workloads. It supports text, image, video, audio, and PDF inputs, and is designed for lightweight agentic...",
        "descriptionAr": "جيميني 3.1 فلاش لايت هو نموذج متعدد الوسائط عالي الكفاءة المتاح عموماً من جوجل، محسّن لأحمال العمل عالية الحجم ذات الكمون المنخفض. يدعم مدخلات النص والصورة والفيديو والصوت وملفات PDF، ومصمم للوكيل الخفيف...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.1-flash-lite",
            "canonicalSlug": "google/gemini-3.1-flash-lite-20260507",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.0000015",
                "image": "0.00000025",
                "audio": "0.0000005",
                "input_audio_cache": "0.00000005",
                "web_search": "0.014",
                "internal_reasoning": "0.0000015",
                "input_cache_read": "0.000000025",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1778168828,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview",
        "description": "Gemini 3.1 Flash Lite Preview is Google's high-efficiency model optimized for high-volume use cases. It outperforms Gemini 2.5 Flash Lite on overall quality and approaches Gemini 2.5 Flash performance across...",
        "descriptionAr": "جيميني 3.1 فلاش لايت معاينة هو نموذج جوجل عالي الكفاءة محسّن لحالات الاستخدام عالية الحجم. يتفوق على جيميني 2.5 فلاش لايت في الجودة العامة ويقترب من أداء جيميني 2.5 فلاش عبر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.1-flash-lite-preview",
            "canonicalSlug": "google/gemini-3.1-flash-lite-preview-20260303",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.0000015",
                "image": "0.00000025",
                "audio": "0.0000005",
                "input_audio_cache": "0.00000005",
                "web_search": "0.014",
                "internal_reasoning": "0.0000015",
                "input_cache_read": "0.000000025",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1772512673,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "description": "Gemini 3.1 Pro Preview is Googleâ€™s frontier reasoning model, delivering enhanced software engineering performance, improved agentic reliability, and more efficient token usage across complex workflows. Building on the multimodal foundation...",
        "descriptionAr": "جيميني 3.1 برو معاينة هو نموذج الاستدلال الحدودي من جوجل، يوفر أداءً هندسياً برمجياً محسناً، وموثوقية وكيلة محسنة، واستخدام رموز أكثر كفاءة عبر سير العمل المعقد. بناءً على الأساس متعدد الوسائط...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "audio",
                "file",
                "image",
                "text",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.1-pro-preview",
            "canonicalSlug": "google/gemini-3.1-pro-preview-20260219",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "image": "0.000002",
                "audio": "0.000002",
                "input_audio_cache": "0.0000002",
                "web_search": "0.014",
                "internal_reasoning": "0.000012",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.000000375",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.000004",
                        "completion": "0.000018",
                        "audio": "0.000004",
                        "input_audio_cache": "0.0000004",
                        "input_cache_read": "0.0000004"
                    }
                ]
            },
            "created": 1771509627,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-pro-preview-customtools",
        "name": "Gemini 3.1 Pro Preview Custom Tools",
        "description": "Gemini 3.1 Pro Preview Custom Tools is a variant of Gemini 3.1 Pro that improves tool selection behavior by preventing overuse of a general bash tool when more efficient third-party...",
        "descriptionAr": "جيميني 3.1 برو معاينة أدوات مخصصة هو متغير من جيميني 3.1 برو يحسن سلوك اختيار الأدوات من خلال منع الإفراط في استخدام أداة باش العامة عندما تكون أدوات الطرف الثالث الأكثر كفاءة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "audio",
                "image",
                "video",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.1-pro-preview-customtools",
            "canonicalSlug": "google/gemini-3.1-pro-preview-customtools-20260219",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "image": "0.000002",
                "audio": "0.000002",
                "input_audio_cache": "0.0000002",
                "web_search": "0.014",
                "internal_reasoning": "0.000012",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.000000375",
                "overrides": [
                    {
                        "min_prompt_tokens": 200000,
                        "prompt": "0.000004",
                        "completion": "0.000018",
                        "audio": "0.000004",
                        "input_audio_cache": "0.0000004",
                        "input_cache_read": "0.0000004"
                    }
                ]
            },
            "created": 1772045923,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "description": "Gemini 3.5 Flash is Google's high-efficiency multimodal model, bringing near-Pro level coding and reasoning at Flash-tier cost and speed. It is highly optimized for coding proficiency and parallel agentic execution...",
        "descriptionAr": "جيميني 3.5 فلاش هو نموذج متعدد الوسائط عالي الكفاءة من جوجل، يجلب برمجة واستدلالاً قريباً من مستوى برو بتكلفة وسرعة فئة فلاش. محسن بشكل كبير لكفاءة البرمجة وتنفيذ الوكيل المتوازي...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.5-flash",
            "canonicalSlug": "google/gemini-3.5-flash-20260519",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000015",
                "completion": "0.000009",
                "image": "0.0000015",
                "audio": "0.000003",
                "input_audio_cache": "0.0000003",
                "web_search": "0.014",
                "internal_reasoning": "0.000009",
                "input_cache_read": "0.00000015",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1779193800,
            "knowledgeCutoff": "2025-01-01",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "description": "Gemini 3.5 Flash Lite is a high-efficiency model from Google with upgraded agentic capabilities. It is suited for subagents that execute focused tasks within complex, multi-agent workflows.",
        "descriptionAr": "جيميني 3.5 فلاش لايت هو نموذج عالي الكفاءة من جوجل بقدرات وكيلية محسنة. مناسب للوكلاء الفرعيين الذين ينفذون مهام مركزة داخل سير العمل المعقد متعدد الوكلاء.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.5-flash-lite",
            "canonicalSlug": "google/gemini-3.5-flash-lite-20260721",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000003",
                "completion": "0.0000025",
                "image": "0.0000003",
                "audio": "0.0000003",
                "input_audio_cache": "0.00000003",
                "web_search": "0.014",
                "internal_reasoning": "0.0000025",
                "input_cache_read": "0.00000003",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1784646726,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash",
        "description": "Gemini 3.6 Flash is a high-efficiency model from Google for coding, agentic workflows, and web and app development. It is designed to produce polished outputs with fewer unnecessary edits and...",
        "descriptionAr": "جيميني 3.6 فلاش هو نموذج عالي الكفاءة من جوجل للبرمجة، وسير العمل الوكيل، وتطوير الويب والتطبيقات. مصمم لإنتاج مخرجات مصقولة مع تعديلات غير ضرورية أقل و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.6-flash",
            "canonicalSlug": "google/gemini-3.6-flash-20260721",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000075",
                "completion": "0.00000375",
                "image": "0.00000075",
                "audio": "0.00000075",
                "input_audio_cache": "0.000000075",
                "web_search": "0.014",
                "internal_reasoning": "0.00000375",
                "input_cache_read": "0.000000075",
                "input_cache_write": "0.0000000416666666666667"
            },
            "created": 1784646733,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash",
        "description": "Gemini 3.7 Flash is a multimodal model from Google for fast agentic workflows, coding, and complex multi-step reasoning. It is designed for tasks that require responsive performance and reliable multi-step...",
        "descriptionAr": "جيميني 3.7 فلاش هو نموذج متعدد الوسائط من جوجل لسير العمل الوكيل السريع، والبرمجة، والاستدلال المعقد متعدد الخطوات. مصمم للمهام التي تتطلب أداءً متجاوباً ومتعدد الخطوات الموثوق...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "video",
                "file",
                "audio"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file+audio+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3.7-flash",
            "canonicalSlug": "google/gemini-3.7-flash-20260813",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000000375",
                "completion": "0.000001875",
                "image": "0.000000375",
                "audio": "0.000000375",
                "input_audio_cache": "0.0000000375",
                "web_search": "0.014",
                "internal_reasoning": "0.000001875",
                "input_cache_read": "0.0000000375",
                "input_cache_write": "0.0000000208333333333333"
            },
            "created": 1786640581,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-2-27b-it",
        "name": "Gemma 2 27B",
        "description": "Gemma 2 27B by Google is an open model built from the same research and technology used to create the [Gemini models](/models?q=gemini). Gemma models are well-suited for a variety of...",
        "descriptionAr": "جيما 2 27B من جوجل هو نموذج مفتوح مبني من نفس البحث والتكنولوجيا المستخدمة لإنشاء [نماذج جيميني](/models?q=gemini). نماذج جيما مناسبة لمجموعة متنوعة من...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 8192,
            "maxOutputTokens": 2048
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemma-2-27b-it",
            "canonicalSlug": "google/gemma-2-27b-it",
            "supportedParameters": [
                "frequency_penalty",
                "max_tokens",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000065",
                "completion": "0.00000065"
            },
            "created": 1720828800,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-3-12b-it",
        "name": "Gemma 3 12B",
        "description": "Gemma 3 introduces multimodality, supporting vision-language input and text outputs. It handles context windows up to 128k tokens, understands over 140 languages, and offers improved math, reasoning, and chat capabilities,...",
        "descriptionAr": "تقدم جيما 3 تعدد الوسائط، وتدعم إدخال الرؤية واللغة والمخرجات النصية. تتعامل مع نوافذ السياق حتى 128 ألف رمز، وتفهم أكثر من 140 لغة، وتوفر قدرات رياضيات واستدلال ودردشة محسنة،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-3-12b-it",
            "canonicalSlug": "google/gemma-3-12b-it",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000005",
                "completion": "0.00000015"
            },
            "created": 1741902625,
            "knowledgeCutoff": "2024-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-3-27b-it",
        "name": "Gemma 3 27B",
        "description": "Gemma 3 introduces multimodality, supporting vision-language input and text outputs. It handles context windows up to 128k tokens, understands over 140 languages, and offers improved math, reasoning, and chat capabilities,...",
        "descriptionAr": "تقدم جيما 3 تعدد الوسائط، وتدعم إدخال الرؤية واللغة والمخرجات النصية. تتعامل مع نوافذ السياق حتى 128 ألف رمز، وتفهم أكثر من 140 لغة، وتوفر قدرات رياضيات واستدلال ودردشة محسنة،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 262144,
            "maxOutputTokens": 131072
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-3-27b-it",
            "canonicalSlug": "google/gemma-3-27b-it",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000008",
                "completion": "0.00000045",
                "input_cache_read": "0.00000004"
            },
            "created": 1741756359,
            "knowledgeCutoff": "2024-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-3-4b-it",
        "name": "Gemma 3 4B",
        "description": "Gemma 3 introduces multimodality, supporting vision-language input and text outputs. It handles context windows up to 128k tokens, understands over 140 languages, and offers improved math, reasoning, and chat capabilities,...",
        "descriptionAr": "تقدم جيما 3 تعدد الوسائط، وتدعم إدخال الرؤية واللغة والمخرجات النصية. تتعامل مع نوافذ السياق حتى 128 ألف رمز، وتفهم أكثر من 140 لغة، وتوفر قدرات رياضيات واستدلال ودردشة محسنة،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemma-3-4b-it",
            "canonicalSlug": "google/gemma-3-4b-it",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000005",
                "completion": "0.0000001"
            },
            "created": 1741905510,
            "knowledgeCutoff": "2024-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-3n-e4b-it",
        "name": "Gemma 3n 4B",
        "description": "Gemma 3n E4B-it is optimized for efficient execution on mobile and low-resource devices, such as phones, laptops, and tablets. It supports multimodal inputsâ€”including text, visual data, and audioâ€”enabling diverse tasks...",
        "descriptionAr": "جيما 3n E4B-it محسّن للتنفيذ الفعال على الأجهزة المحمولة والأجهزة منخفضة الموارد، مثل الهواتف وأجهزة الكمبيوتر المحمولة والأجهزة اللوحية. يدعم مدخلات متعددة الوسائط - بما في ذلك النص والبيانات البصرية والصوت - مما يتيح مهام متنوعة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 32768,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemma-3n-e4b-it",
            "canonicalSlug": "google/gemma-3n-e4b-it",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "repetition_penalty",
                "response_format",
                "stop",
                "structured_outputs",
                "temperature",
                "top_k",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000006",
                "completion": "0.00000012"
            },
            "created": 1747776824,
            "knowledgeCutoff": "2024-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-4-26b-a4b-it",
        "name": "Gemma 4 26B A4B ",
        "description": "Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference â€” delivering near-31B quality at...",
        "descriptionAr": "جيما 4 26B A4B IT هو نموذج مزيج الخبراء (MoE) المعد للتعليمات من جوجل ديب مايند. على الرغم من إجمالي 25.2 مليار معامل، يتم تنشيط 3.8 مليار فقط لكل رمز أثناء الاستدلال - مما يوفر جودة قريبة من 31 مليار بـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 262144,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-4-26b-a4b-it",
            "canonicalSlug": "google/gemma-4-26b-a4b-it-20260403",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000007",
                "completion": "0.00000034"
            },
            "created": 1775227989,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-4-26b-a4b-it:free",
        "name": "Gemma 4 26B A4B  (free)",
        "description": "Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference â€” delivering near-31B quality at...",
        "descriptionAr": "جيما 4 26B A4B IT هو نموذج مزيج الخبراء (MoE) المعد للتعليمات من جوجل ديب مايند. على الرغم من إجمالي 25.2 مليار معامل، يتم تنشيط 3.8 مليار فقط لكل رمز أثناء الاستدلال - مما يوفر جودة قريبة من 31 مليار بـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 262144,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-4-26b-a4b-it:free",
            "canonicalSlug": "google/gemma-4-26b-a4b-it-20260403",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0",
                "completion": "0"
            },
            "created": 1775227989,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-4-31b-it",
        "name": "Gemma 4 31B",
        "description": "Gemma 4 31B Instruct is Google DeepMind's 30.7B dense multimodal model supporting text and image input with text output. Features a 256K token context window, configurable thinking/reasoning mode, native function...",
        "descriptionAr": "جيما 4 31B إنستراكت هو النموذج المتعدد الوسائط الكثيف بـ 30.7 مليار من جوجل ديب مايند، يدعم إدخال النص والصورة مع مخرجات نصية. يتميز بنافذة سياق بـ 256 ألف رمز، ووضع تفكير/استدلال قابل للتكوين، ودعم الدوال الأصلي...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 262144,
            "maxOutputTokens": 262144
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-4-31b-it",
            "canonicalSlug": "google/gemma-4-31b-it-20260402",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000001",
                "completion": "0.00000034",
                "input_cache_read": "0.0000001"
            },
            "created": 1775148486,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemma-4-31b-it:free",
        "name": "Gemma 4 31B (free)",
        "description": "Gemma 4 31B Instruct is Google DeepMind's 30.7B dense multimodal model supporting text and image input with text output. Features a 256K token context window, configurable thinking/reasoning mode, native function...",
        "descriptionAr": "جيما 4 31B إنستراكت هو النموذج المتعدد الوسائط الكثيف بـ 30.7 مليار من جوجل ديب مايند، يدعم إدخال النص والصورة مع مخرجات نصية. يتميز بنافذة سياق بـ 256 ألف رمز، ووضع تفكير/استدلال قابل للتكوين، ودعم الدوال الأصلي...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "video"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+video->text"
        },
        "contextWindow": {
            "maxInputTokens": 262144,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemma-4-31b-it:free",
            "canonicalSlug": "google/gemma-4-31b-it-20260402",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0",
                "completion": "0"
            },
            "created": 1775148486,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "lyria-3-clip-preview",
        "name": "Lyria 3 Clip Preview",
        "description": "30 second duration clips are priced at $0.04 per clip. Lyria 3 is Google's family of music generation models, available through the Gemini API. With Lyria 3, you can generate...",
        "descriptionAr": "تسعير المقاطع مدتها 30 ثانية بـ 0.04 دولار لكل مقطع. ليريا 3 هي عائلة نماذج توليد الموسيقى من جوجل، المتاحة عبر واجهة برمجة تطبيقات جيميني. مع ليريا 3، يمكنك توليد...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text",
                "audio"
            ],
            "modality": "text+image->text+audio"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/lyria-3-clip-preview",
            "canonicalSlug": "google/lyria-3-clip-preview-20260330",
            "supportedParameters": [
                "max_tokens",
                "response_format",
                "seed",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0",
                "completion": "0"
            },
            "created": 1774907255,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "lyria-3-pro-preview",
        "name": "Lyria 3 Pro Preview",
        "description": "Full-length songs are priced at $0.08 per song. Lyria 3 is Google's family of music generation models, available through the Gemini API. With Lyria 3, you can generate high-quality, 48kHz...",
        "descriptionAr": "تسعير الأغاني الكاملة بـ 0.08 دولار لكل أغنية. ليريا 3 هي عائلة نماذج توليد الموسيقى من جوجل، المتاحة عبر واجهة برمجة تطبيقات جيميني. مع ليريا 3، يمكنك توليد جودة عالية، 48 كيلوهرتز...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text",
                "audio"
            ],
            "modality": "text+image->text+audio"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/lyria-3-pro-preview",
            "canonicalSlug": "google/lyria-3-pro-preview-20260330",
            "supportedParameters": [
                "max_tokens",
                "response_format",
                "seed",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0",
                "completion": "0"
            },
            "created": 1774907286,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-2.5-flash-image",
        "name": "Nano Banana (Gemini 2.5 Flash Image)",
        "description": "Gemini 2.5 Flash Image, a.k.a. \"Nano Banana,\" is now generally available. It is a state of the art image generation model with contextual understanding. It is capable of image generation,...",
        "descriptionAr": "جيميني 2.5 فلاش إيميج، المعروف أيضاً باسم \"نانو بانانا\"، متاح الآن بشكل عام. هو نموذج توليد صور متطور مع فهم سياقي. قادر على توليد الصور،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 32768,
            "maxOutputTokens": 8192
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemini-2.5-flash-image",
            "canonicalSlug": "google/gemini-2.5-flash-image",
            "supportedParameters": [
                "max_tokens",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000003",
                "completion": "0.0000025",
                "image": "0.0000003",
                "image_output": "0.00003",
                "audio": "0.000001",
                "input_audio_cache": "0.0000001",
                "web_search": "0.014",
                "internal_reasoning": "0.0000025",
                "input_cache_read": "0.00000003",
                "input_cache_write": "0.0000000833333333333333"
            },
            "created": 1759870431,
            "knowledgeCutoff": "2025-01-31",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-flash-image-preview",
        "name": "Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
        "description": "Gemini 3.1 Flash Image Preview, a.k.a. \"Nano Banana 2,\" is Googleâ€™s latest state of the art image generation and editing model, delivering Pro-level visual quality at Flash speed. It combines...",
        "descriptionAr": "جيميني 3.1 فلاش إيميج معاينة، المعروف أيضاً باسم \"نانو بانانا 2\"، هو أحدث نموذج توليد وتحرير صور متطور من جوجل، يقدم جودة بصرية مستوى برو بسرعة فلاش. يجمع...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 65536,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemini-3.1-flash-image-preview",
            "canonicalSlug": "google/gemini-3.1-flash-image-preview-20260226",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000005",
                "completion": "0.000003",
                "image_output": "0.00006",
                "web_search": "0.014"
            },
            "created": 1772119558,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-flash-image",
        "name": "Nano Banana 2 (Gemini 3.1 Flash Image)",
        "description": "Gemini 3.1 Flash Image, a.k.a. \"Nano Banana 2,\" is Googleâ€™s latest state of the art image generation and editing model, delivering Pro-level visual quality at Flash speed. It combines advanced...",
        "descriptionAr": "جيميني 3.1 فلاش إيميج، المعروف أيضاً باسم \"نانو بانانا 2\"، هو أحدث نموذج توليد وتحرير صور متطور من جوجل، يقدم جودة بصرية مستوى برو بسرعة فلاش. يجمع...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemini-3.1-flash-image",
            "canonicalSlug": "google/gemini-3.1-flash-image-20260528",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000005",
                "completion": "0.000003",
                "image_output": "0.00006",
                "web_search": "0.014"
            },
            "created": 1781754065,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3.1-flash-lite-image",
        "name": "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)",
        "description": "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image) is Google's fastest, most cost-efficient Gemini image model, built for high-velocity developer pipelines and rapid-fire visual exploration. It delivers text-to-image generation...",
        "descriptionAr": "نانو بانانا 2 لايت (جيميني 3.1 فلاش لايت إيميج) هو أسرع نموذج صور جيميني وأكثر كفاءة من حيث التكلفة من جوجل، مبني لخطوط أنابيب المطورين عالية السرعة والاستكشاف البصري السريع المتتالي. يوفر توليد النص إلى الصورة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 65536,
            "maxOutputTokens": 66000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemini-3.1-flash-lite-image",
            "canonicalSlug": "google/gemini-3.1-flash-lite-image-20260630",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.0000015",
                "image_output": "0.00003",
                "web_search": "0.014"
            },
            "created": 1782837225,
            "knowledgeCutoff": "2025-01-01",
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3-pro-image-preview",
        "name": "Nano Banana Pro (Gemini 3 Pro Image Preview)",
        "description": "Nano Banana Pro is Googleâ€™s most advanced image-generation and editing model, built on Gemini 3 Pro. It extends the original Nano Banana with significantly improved multimodal reasoning, real-world grounding, and...",
        "descriptionAr": "نانو بانانا برو هو أكثر نماذج توليد وتحرير الصور تقدماً من جوجل، مبني على جيميني 3 برو. يمد النموذج نانو بانانا الأصلي باستدلال متعدد الوسائط محسن بشكل كبير، والتأريض الواقعي، و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 65536,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "google/gemini-3-pro-image-preview",
            "canonicalSlug": "google/gemini-3-pro-image-preview-20251120",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "image": "0.000002",
                "image_output": "0.00012",
                "audio": "0.000002",
                "input_audio_cache": "0.0000002",
                "web_search": "0.014",
                "internal_reasoning": "0.000012",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.000000375"
            },
            "created": 1763653797,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "google",
        "modelCode": "gemini-3-pro-image",
        "name": "Nano Banana Pro (Gemini 3 Pro Image)",
        "description": "Nano Banana Pro is Googleâ€™s most advanced image-generation and editing model, built on Gemini 3 Pro. It extends the original Nano Banana with significantly improved multimodal reasoning, real-world grounding, and...",
        "descriptionAr": "نانو بانانا برو هو أكثر نماذج توليد وتحرير الصور تقدماً من جوجل، مبني على جيميني 3 برو. يمد النموذج نانو بانانا الأصلي باستدلال متعدد الوسائط محسن بشكل كبير، والتأريض الواقعي، و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "google/gemini-3-pro-image",
            "canonicalSlug": "google/gemini-3-pro-image-20260528",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "image": "0.000002",
                "image_output": "0.00012",
                "audio": "0.000002",
                "input_audio_cache": "0.0000002",
                "web_search": "0.014",
                "internal_reasoning": "0.000012",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.000000375"
            },
            "created": 1781754054,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-audio",
        "name": "GPT Audio",
        "description": "The gpt-audio model is OpenAI's first generally available audio model. The new snapshot features an upgraded decoder for more natural sounding voices and maintains better voice consistency. Audio is priced...",
        "descriptionAr": "نموذج gpt-audio هو أول نموذج صوتي متاح بشكل عام من أوبن إي آي. تتميز اللقطة الجديدة بفك ترميز محسن لأصوات طبيعية أكثر وتحافظ على اتساق الصوت بشكل أفضل. الصوت مسعر بـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "audio"
            ],
            "output": [
                "text",
                "audio"
            ],
            "modality": "text+audio->text+audio"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-audio",
            "canonicalSlug": "openai/gpt-audio",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.00001",
                "audio": "0.000032",
                "audio_output": "0.000064"
            },
            "created": 1768862569,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-audio-mini",
        "name": "GPT Audio Mini",
        "description": "A cost-efficient version of GPT Audio. The new snapshot features an upgraded decoder for more natural sounding voices and maintains better voice consistency. Input is priced at $0.60 per million...",
        "descriptionAr": "نسخة فعالة من حيث التكلفة من GPT الصوتي. تتميز اللقطة الجديدة بفك ترميز محسن لأصوات طبيعية أكثر وتحافظ على اتساق الصوت بشكل أفضل. الإدخال مسعر بـ 0.60 دولار لكل مليون...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "audio"
            ],
            "output": [
                "text",
                "audio"
            ],
            "modality": "text+audio->text+audio"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-audio-mini",
            "canonicalSlug": "openai/gpt-audio-mini",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000006",
                "completion": "0.0000024",
                "audio": "0.0000006",
                "audio_output": "0.0000024"
            },
            "created": 1768859419,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-chat-latest",
        "name": "GPT Chat Latest",
        "description": "GPT Chat Latest points to OpenAI's stable API alias `chat-latest` that always resolves to the latest Instant chat model used in ChatGPT. As OpenAI rolls out new Instant model updates...",
        "descriptionAr": "يشير GPT Chat Latest إلى الاسم المستعار المستقر لواجهة برمجة التطبيقات من أوبن إي آي `chat-latest` الذي يحل دائماً لأحدث نموذج دردشة فوري المستخدم في ChatGPT. مع طرح أوبن إي آي تحديثات نموذج فورية جديدة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-chat-latest",
            "canonicalSlug": "openai/gpt-chat-latest-20260505",
            "supportedParameters": [
                "max_tokens",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.00003",
                "web_search": "0.01",
                "input_cache_read": "0.0000005"
            },
            "created": 1778000212,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-3.5-turbo",
        "name": "GPT-3.5 Turbo",
        "description": "GPT-3.5 Turbo is OpenAI's fastest model. It can understand and generate natural language or code, and is optimized for chat and traditional completion tasks.\n\nTraining data up to Sep 2021.",
        "descriptionAr": "GPT-3.5 تيربو هو أسرع نماذج أوبن إي آي. يمكنه فهم وتوليد اللغة الطبيعية أو الكود، ومحسّن للدردشة ومهام الإكمال التقليدية. بيانات التدريب حتى سبتمبر 2021.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 16385,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-3.5-turbo",
            "canonicalSlug": "openai/gpt-3.5-turbo",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000005",
                "completion": "0.0000015"
            },
            "created": 1685232000,
            "knowledgeCutoff": "2021-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-3.5-turbo-0613",
        "name": "GPT-3.5 Turbo (older v0613)",
        "description": "GPT-3.5 Turbo is OpenAI's fastest model. It can understand and generate natural language or code, and is optimized for chat and traditional completion tasks.\n\nTraining data up to Sep 2021.",
        "descriptionAr": "GPT-3.5 تيربو هو أسرع نماذج أوبن إي آي. يمكنه فهم وتوليد اللغة الطبيعية أو الكود، ومحسّن للدردشة ومهام الإكمال التقليدية. بيانات التدريب حتى سبتمبر 2021.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 4095,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-3.5-turbo-0613",
            "canonicalSlug": "openai/gpt-3.5-turbo-0613",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000001",
                "completion": "0.000002"
            },
            "created": 1706140800,
            "knowledgeCutoff": "2021-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-3.5-turbo-16k",
        "name": "GPT-3.5 Turbo 16k",
        "description": "This model offers four times the context length of gpt-3.5-turbo, allowing it to support approximately 20 pages of text in a single request at a higher cost. Training data: up...",
        "descriptionAr": "يوفر هذا النموذج أربعة أضعاف طول السياق من gpt-3.5-turbo، مما يسمح له بدعم حوالي 20 صفحة من النص في طلب واحد بتكلفة أعلى. بيانات التدريب: حتى...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 16385,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-3.5-turbo-16k",
            "canonicalSlug": "openai/gpt-3.5-turbo-16k",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000004"
            },
            "created": 1693180800,
            "knowledgeCutoff": "2021-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-3.5-turbo-instruct",
        "name": "GPT-3.5 Turbo Instruct",
        "description": "This model is a variant of GPT-3.5 Turbo tuned for instructional prompts and omitting chat-related optimizations. Training data: up to Sep 2021.",
        "descriptionAr": "هذا النموذج هو متغير من GPT-3.5 تيربو مضبوط لمطالبات التعليمات وحذف التحسينات المتعلقة بالدردشة. بيانات التدريب: حتى سبتمبر 2021.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 4095,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "openai/gpt-3.5-turbo-instruct",
            "canonicalSlug": "openai/gpt-3.5-turbo-instruct",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000015",
                "completion": "0.000002"
            },
            "created": 1695859200,
            "knowledgeCutoff": "2021-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4",
        "name": "GPT-4",
        "description": "OpenAI's flagship model, GPT-4 is a large-scale multimodal language model capable of solving difficult problems with greater accuracy than previous models due to its broader general knowledge and advanced reasoning...",
        "descriptionAr": "النموذج الرائد من أوبن إي آي، GPT-4 هو نموذج لغوي متعدد الوسائط واسع النطاق قادر على حل المشكلات الصعبة بدقة أكبر من النماذج السابقة بسبب معرفته العامة الأوسع وقدرات الاستدلال المتقدمة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 8191,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4",
            "canonicalSlug": "openai/gpt-4",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00003",
                "completion": "0.00006"
            },
            "created": 1685232000,
            "knowledgeCutoff": "2021-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4-turbo",
        "name": "GPT-4 Turbo",
        "description": "The latest GPT-4 Turbo model with vision capabilities. Vision requests can now use JSON mode and function calling.\n\nTraining data: up to December 2023.",
        "descriptionAr": "أحدث نموذج GPT-4 تيربو مع قدرات الرؤية. يمكن لطلبات الرؤية الآن استخدام وضع JSON واستدعاء الدوال. بيانات التدريب: حتى ديسمبر 2023.",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4-turbo",
            "canonicalSlug": "openai/gpt-4-turbo",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00003"
            },
            "created": 1712620800,
            "knowledgeCutoff": "2023-12-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4-turbo-preview",
        "name": "GPT-4 Turbo Preview",
        "description": "The preview GPT-4 model with improved instruction following, JSON mode, reproducible outputs, parallel function calling, and more. Training data: up to Dec 2023. **Note:** heavily rate limited by OpenAI while...",
        "descriptionAr": "النموذج المعاين GPT-4 مع تحسين اتباع التعليمات، ووضع JSON، والمخرجات القابلة للتكرار، واستدعاء الدوال المتوازي، وأكثر من ذلك. بيانات التدريب: حتى ديسمبر 2023. **ملاحظة:** محدود بشدة بواسطة أوبن إي آي بينما...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4-turbo-preview",
            "canonicalSlug": "openai/gpt-4-turbo-preview",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00003"
            },
            "created": 1706140800,
            "knowledgeCutoff": "2023-12-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4.1",
        "name": "GPT-4.1",
        "description": "GPT-4.1 is a flagship large language model optimized for advanced instruction following, real-world software engineering, and long-context reasoning. It supports a 1 million token context window and outperforms GPT-4o and...",
        "descriptionAr": "GPT-4.1 هو نموذج لغوي كبير رائد محسّن لاتباع التعليمات المتقدمة، والهندسة البرمجية الواقعية، والاستدلال طويل السياق. يدعم نافذة سياق بـ 1 مليون رمز ويتفوق على GPT-4o و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1047576,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4.1",
            "canonicalSlug": "openai/gpt-4.1-2025-04-14",
            "supportedParameters": [
                "max_completion_tokens",
                "max_tokens",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000008",
                "web_search": "0.01",
                "input_cache_read": "0.0000005"
            },
            "created": 1744651385,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4.1-mini",
        "name": "GPT-4.1 Mini",
        "description": "GPT-4.1 Mini is a mid-sized model delivering performance competitive with GPT-4o at substantially lower latency and cost. It retains a 1 million token context window and scores 45.1% on hard...",
        "descriptionAr": "GPT-4.1 ميني هو نموذج متوسط الحجم يوفر أداءً تنافسياً مع GPT-4o بكمون وتكلفة أقل بكثير. يحتفظ بنافذة سياق بـ 1 مليون رمز ويسجل 45.1% في المهام الصعبة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1047576,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4.1-mini",
            "canonicalSlug": "openai/gpt-4.1-mini-2025-04-14",
            "supportedParameters": [
                "max_completion_tokens",
                "max_tokens",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000004",
                "completion": "0.0000016",
                "web_search": "0.01",
                "input_cache_read": "0.0000001"
            },
            "created": 1744651381,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4.1-nano",
        "name": "GPT-4.1 Nano",
        "description": "For tasks that demand low latency, GPTâ€‘4.1 nano is the fastest and cheapest model in the GPT-4.1 series. It delivers exceptional performance at a small size with its 1 million...",
        "descriptionAr": "بالنسبة للمهام التي تتطلب كمون منخفض، يعد GPT-4.1 نانو أسرع وأرخص نموذج في سلسلة GPT-4.1. يقدم أداءً استثنائياً بحجم صغير مع نافذة سياقه بـ 1 مليون...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1047576,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4.1-nano",
            "canonicalSlug": "openai/gpt-4.1-nano-2025-04-14",
            "supportedParameters": [
                "max_completion_tokens",
                "max_tokens",
                "response_format",
                "seed",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000001",
                "completion": "0.0000004",
                "web_search": "0.01",
                "input_cache_read": "0.000000025"
            },
            "created": 1744651369,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o",
        "name": "GPT-4o",
        "description": "GPT-4o (\"o\" for \"omni\") is OpenAI's latest AI model, supporting both text and image inputs with text outputs. It maintains the intelligence level of [GPT-4 Turbo](/models/openai/gpt-4-turbo) while being twice as...",
        "descriptionAr": "GPT-4o (الحرف \"o\" لـ \"omni\" أي شامل) هو أحدث نموذج ذكاء اصطناعي من أوبن إي آي، يدعم مدخلات النص والصورة مع مخرجات نصية. يحافظ على مستوى ذكاء [GPT-4 تيربو](/models/openai/gpt-4-turbo) بينما يكون أسرع بمرتين...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o",
            "canonicalSlug": "openai/gpt-4o",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.00001",
                "input_cache_read": "0.00000125"
            },
            "created": 1715558400,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o-2024-05-13",
        "name": "GPT-4o (2024-05-13)",
        "description": "GPT-4o (\"o\" for \"omni\") is OpenAI's latest AI model, supporting both text and image inputs with text outputs. It maintains the intelligence level of [GPT-4 Turbo](/models/openai/gpt-4-turbo) while being twice as...",
        "descriptionAr": "GPT-4o (الحرف \"o\" لـ \"omni\" أي شامل) هو أحدث نموذج ذكاء اصطناعي من أوبن إي آي، يدعم مدخلات النص والصورة مع مخرجات نصية. يحافظ على مستوى ذكاء [GPT-4 تيربو](/models/openai/gpt-4-turbo) بينما يكون أسرع بمرتين...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o-2024-05-13",
            "canonicalSlug": "openai/gpt-4o-2024-05-13",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.000015"
            },
            "created": 1715558400,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o-2024-08-06",
        "name": "GPT-4o (2024-08-06)",
        "description": "The 2024-08-06 version of GPT-4o offers improved performance in structured outputs, with the ability to supply a JSON schema in the respone_format. Read more [here](https://openai.com/index/introducing-structured-outputs-in-the-api/). GPT-4o (\"o\" for \"omni\") is...",
        "descriptionAr": "تقدم نسخة 2024-08-06 من GPT-4o أداءً محسناً في المخرجات المنظمة، مع القدرة على توفير مخطط JSON في تنسيق الاستجابة. اقرأ المزيد [هنا](https://openai.com/index/introducing-structured-outputs-in-the-api/). GPT-4o (الحرف \"o\" لـ \"omni\") هو...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o-2024-08-06",
            "canonicalSlug": "openai/gpt-4o-2024-08-06",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.00001",
                "input_cache_read": "0.00000125"
            },
            "created": 1722902400,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o-2024-11-20",
        "name": "GPT-4o (2024-11-20)",
        "description": "The 2024-11-20 version of GPT-4o offers a leveled-up creative writing ability with more natural, engaging, and tailored writing to improve relevance & readability. Itâ€™s also better at working with uploaded...",
        "descriptionAr": "تقدم نسخة 2024-11-20 من GPT-4o قدرة كتابة إبداعية محسنة مع كتابة أكثر طبيعية وجاذبية وتصميماً لتحسين الصلة وقابلية القراءة. كما أنها أفضل في العمل مع الملفات المرفوعة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o-2024-11-20",
            "canonicalSlug": "openai/gpt-4o-2024-11-20",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.00001",
                "input_cache_read": "0.00000125"
            },
            "created": 1732127594,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o-mini",
        "name": "GPT-4o-mini",
        "description": "GPT-4o mini is OpenAI's newest model after [GPT-4 Omni](/models/openai/gpt-4o), supporting both text and image inputs with text outputs. As their most advanced small model, it is many multiples more affordable...",
        "descriptionAr": "GPT-4o ميني هو أحدث نموذج من أوبن إي آي بعد [GPT-4 أومني](/models/openai/gpt-4o)، يدعم مدخلات النص والصورة مع مخرجات نصية. كنموذج صغير متقدم لديهم، فهو بأسعار معقولة بمضاعفات كثيرة أكثر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o-mini",
            "canonicalSlug": "openai/gpt-4o-mini",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_completion_tokens",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.00000015",
                "completion": "0.0000006",
                "input_cache_read": "0.000000075"
            },
            "created": 1721260800,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-4o-mini-2024-07-18",
        "name": "GPT-4o-mini (2024-07-18)",
        "description": "GPT-4o mini is OpenAI's newest model after [GPT-4 Omni](/models/openai/gpt-4o), supporting both text and image inputs with text outputs. As their most advanced small model, it is many multiples more affordable...",
        "descriptionAr": "GPT-4o ميني هو أحدث نموذج من أوبن إي آي بعد [GPT-4 أومني](/models/openai/gpt-4o)، يدعم مدخلات النص والصورة مع مخرجات نصية. كنموذج صغير متقدم لديهم، فهو بأسعار معقولة بمضاعفات كثيرة أكثر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-4o-mini-2024-07-18",
            "canonicalSlug": "openai/gpt-4o-mini-2024-07-18",
            "supportedParameters": [
                "frequency_penalty",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "prediction",
                "presence_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_logprobs",
                "top_p",
                "web_search_options"
            ],
            "pricing": {
                "prompt": "0.00000015",
                "completion": "0.0000006",
                "input_cache_read": "0.000000075"
            },
            "created": 1721260800,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5",
        "name": "GPT-5",
        "description": "GPT-5 is OpenAIâ€™s most advanced model, offering major improvements in reasoning, code quality, and user experience. It is optimized for complex tasks that require step-by-step reasoning, instruction following, and accuracy...",
        "descriptionAr": "GPT-5 هو أكثر نماذج أوبن إي آي تقدماً، ويقدم تحسينات كبيرة في الاستدلال وجودة الكود وتجربة المستخدم. محسّن للمهام المعقدة التي تتطلب استدلالاً خطوة بخطوة، واتباع التعليمات، والدقة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5",
            "canonicalSlug": "openai/gpt-5-2025-08-07",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "web_search": "0.01",
                "input_cache_read": "0.000000125"
            },
            "created": 1754587413,
            "knowledgeCutoff": "2024-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5-image",
        "name": "GPT-5 Image",
        "description": "[GPT-5](https://openrouter.ai/openai/gpt-5) Image combines OpenAI's GPT-5 model with state-of-the-art image generation capabilities. It offers major improvements in reasoning, code quality, and user experience while incorporating GPT Image 1's superior instruction following,...",
        "descriptionAr": "[GPT-5](https://openrouter.ai/openai/gpt-5) إيميج يجمع نموذج GPT-5 من أوبن إي آي مع قدرات توليد صور متطورة. يقدم تحسينات كبيرة في الاستدلال وجودة الكود وتجربة المستخدم مع دمج اتباع التعليمات المتفوق لـ GPT إيميج 1،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image+file->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "openai/gpt-5-image",
            "canonicalSlug": "openai/gpt-5-image",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00001",
                "completion": "0.00001",
                "image_output": "0.00004",
                "web_search": "0.01",
                "input_cache_read": "0.00000125"
            },
            "created": 1760447986,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5-image-mini",
        "name": "GPT-5 Image Mini",
        "description": "GPT-5 Image Mini combines OpenAI's advanced language capabilities, powered by [GPT-5 Mini](https://openrouter.ai/openai/gpt-5-mini), with GPT Image 1 Mini for efficient image generation. This natively multimodal model features superior instruction following, text...",
        "descriptionAr": "يجمع GPT-5 إيميج ميني قدرات اللغة المتقدمة من أوبن إي آي، المدعومة بـ [GPT-5 ميني](https://openrouter.ai/openai/gpt-5-mini)، مع GPT إيميج 1 ميني لتوليد الصور بكفاءة. هذا النموذج متعدد الوسائط الأصلي يتميز باتباع التعليمات المتفوق، والنص...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image+file->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "openai/gpt-5-image-mini",
            "canonicalSlug": "openai/gpt-5-image-mini",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.000002",
                "image_output": "0.000008",
                "web_search": "0.01",
                "input_cache_read": "0.00000025"
            },
            "created": 1760624583,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5-mini",
        "name": "GPT-5 Mini",
        "description": "GPT-5 Mini is a compact version of GPT-5, designed to handle lighter-weight reasoning tasks. It provides the same instruction-following and safety-tuning benefits as GPT-5, but with reduced latency and cost....",
        "descriptionAr": "GPT-5 ميني هو نسخة مضغوطة من GPT-5، مصممة للتعامل مع مهام الاستدلال الأخف وزناً. يوفر نفس فوائد اتباع التعليمات والضبط الآمني مثل GPT-5، ولكن مع كمون وتكلفة مخفضين....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5-mini",
            "canonicalSlug": "openai/gpt-5-mini-2025-08-07",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.000002",
                "web_search": "0.01",
                "input_cache_read": "0.000000025"
            },
            "created": 1754587407,
            "knowledgeCutoff": "2024-05-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5-nano",
        "name": "GPT-5 Nano",
        "description": "GPT-5-Nano is the smallest and fastest variant in the GPT-5 system, optimized for developer tools, rapid interactions, and ultra-low latency environments. While limited in reasoning depth compared to its larger...",
        "descriptionAr": "GPT-5-نانو هو أصغر وأسرع متغير في نظام GPT-5، محسّن لأدوات المطورين والتفاعلات السريعة وبيئات الكمون فائق الانخفاض. بينما محدود في عمق الاستدلال مقارنة بنظيره الأكبر...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5-nano",
            "canonicalSlug": "openai/gpt-5-nano-2025-08-07",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000005",
                "completion": "0.0000004",
                "web_search": "0.01",
                "input_cache_read": "0.000000005"
            },
            "created": 1754587402,
            "knowledgeCutoff": "2024-05-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5-pro",
        "name": "GPT-5 Pro",
        "description": "GPT-5 Pro is OpenAIâ€™s most advanced model, offering major improvements in reasoning, code quality, and user experience. It is optimized for complex tasks that require step-by-step reasoning, instruction following, and...",
        "descriptionAr": "GPT-5 برو هو أكثر نماذج أوبن إي آي تقدماً، ويقدم تحسينات كبيرة في الاستدلال وجودة الكود وتجربة المستخدم. محسّن للمهام المعقدة التي تتطلب استدلالاً خطوة بخطوة، واتباع التعليمات، و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5-pro",
            "canonicalSlug": "openai/gpt-5-pro-2025-10-06",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000015",
                "completion": "0.00012",
                "web_search": "0.01"
            },
            "created": 1759776663,
            "knowledgeCutoff": "2024-09-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.1",
        "name": "GPT-5.1",
        "description": "GPT-5.1 is the latest frontier-grade model in the GPT-5 series, offering stronger general-purpose reasoning, improved instruction adherence, and a more natural conversational style compared to GPT-5. It uses adaptive reasoning...",
        "descriptionAr": "GPT-5.1 هو أحدث نموذج من الدرجة الحدودية في سلسلة GPT-5، ويقدم استدلالاً عاماً أقوى، وتقيداً محسناً بالتعليمات، وأسلوب محادثة أكثر طبيعية مقارنة بـ GPT-5. يستخدم استدلالاً تكيفياً...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.1",
            "canonicalSlug": "openai/gpt-5.1-20251113",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "web_search": "0.01",
                "input_cache_read": "0.000000125"
            },
            "created": 1763060305,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.1-codex",
        "name": "GPT-5.1-Codex",
        "description": "GPT-5.1-Codex is a specialized version of GPT-5.1 optimized for software engineering and coding workflows. It is designed for both interactive development sessions and long, independent execution of complex engineering tasks....",
        "descriptionAr": "GPT-5.1-كوديكس هو نسخة متخصصة من GPT-5.1 محسّنة للهندسة البرمجية وسير عمل البرمجة. مصمم لكل من جلسات التطوير التفاعلية والتنفيذ الطويل المستقل لمهام الهندسة المعقدة....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.1-codex",
            "canonicalSlug": "openai/gpt-5.1-codex-20251113",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "web_search": "0.01",
                "input_cache_read": "0.00000013"
            },
            "created": 1763060298,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.1-codex-max",
        "name": "GPT-5.1-Codex-Max",
        "description": "GPT-5.1-Codex-Max is OpenAIâ€™s latest agentic coding model, designed for long-running, high-context software development tasks. It is based on an updated version of the 5.1 reasoning stack and trained on agentic...",
        "descriptionAr": "GPT-5.1-كوديكس-ماكس هو أحدث نموذج برمجة وكيل من أوبن إي آي، مصمم لمهام تطوير البرمجيات طويلة التشغيل عالية السياق. مبني على نسخة محدثة من مكدس الاستدلال 5.1 ومدرب على سير العمل الوكيل...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.1-codex-max",
            "canonicalSlug": "openai/gpt-5.1-codex-max-20251204",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000125",
                "completion": "0.00001",
                "web_search": "0.01",
                "input_cache_read": "0.000000125"
            },
            "created": 1764878934,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.1-codex-mini",
        "name": "GPT-5.1-Codex-Mini",
        "description": "GPT-5.1-Codex-Mini is a smaller and faster version of GPT-5.1-Codex",
        "descriptionAr": "GPT-5.1-كوديكس-ميني هو نسخة أصغر وأسرع من GPT-5.1-كوديكس",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.1-codex-mini",
            "canonicalSlug": "openai/gpt-5.1-codex-mini-20251113",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000025",
                "completion": "0.000002",
                "web_search": "0.01",
                "input_cache_read": "0.00000003"
            },
            "created": 1763057820,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.2",
        "name": "GPT-5.2",
        "description": "GPT-5.2 is the latest frontier-grade model in the GPT-5 series, offering stronger agentic and long context perfomance compared to GPT-5.1. It uses adaptive reasoning to allocate computation dynamically, responding quickly...",
        "descriptionAr": "GPT-5.2 هو أحدث نموذج من الدرجة الحدودية في سلسلة GPT-5، ويقدم أداءً وكيلاً وسياقاً طويلاً أقوى مقارنة بـ GPT-5.1. يستخدم استدلالاً تكيفياً لتخصيص الحساب ديناميكياً، مستجيباً بسرعة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.2",
            "canonicalSlug": "openai/gpt-5.2-20251211",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000175",
                "completion": "0.000014",
                "web_search": "0.01",
                "input_cache_read": "0.000000175"
            },
            "created": 1765389775,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.2-chat",
        "name": "GPT-5.2 Chat",
        "description": "GPT-5.2 Chat (AKA Instant) is the fast, lightweight member of the 5.2 family, optimized for low-latency chat while retaining strong general intelligence. It uses adaptive reasoning to selectively â€œthinkâ€ on...",
        "descriptionAr": "GPT-5.2 دردشة (المعروف أيضاً باسم إنستانت) هو العضو السريع الخفيف في عائلة 5.2، محسّن للدردشة ذات الكمون المنخفض مع الحفاظ على الذكاء العام القوي. يستخدم استدلالاً تكيفياً لـ \"التفكير\" بشكل انتقائي على...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": 32000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.2-chat",
            "canonicalSlug": "openai/gpt-5.2-chat-20251211",
            "supportedParameters": [
                "max_completion_tokens",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000175",
                "completion": "0.000014",
                "web_search": "0.01",
                "input_cache_read": "0.000000175"
            },
            "created": 1765389783,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.2-pro",
        "name": "GPT-5.2 Pro",
        "description": "GPT-5.2 Pro is OpenAIâ€™s most advanced model, offering major improvements in agentic coding and long context performance over GPT-5 Pro. It is optimized for complex tasks that require step-by-step reasoning,...",
        "descriptionAr": "GPT-5.2 برو هو أكثر نماذج أوبن إي آي تقدماً، ويقدم تحسينات كبيرة في البرمجة الوكيلة وأداء السياق الطويل مقارنة بـ GPT-5 برو. محسّن للمهام المعقدة التي تتطلب استدلالاً خطوة بخطوة، ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.2-pro",
            "canonicalSlug": "openai/gpt-5.2-pro-20251211",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000021",
                "completion": "0.000168",
                "web_search": "0.01"
            },
            "created": 1765389780,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.2-codex",
        "name": "GPT-5.2-Codex",
        "description": "GPT-5.2-Codex is an upgraded version of GPT-5.1-Codex optimized for software engineering and coding workflows. It is designed for both interactive development sessions and long, independent execution of complex engineering tasks....",
        "descriptionAr": "GPT-5.2-كوديكس هو نسخة محدثة من GPT-5.1-كوديكس محسّنة للهندسة البرمجية وسير عمل البرمجة. مصمم لكل من جلسات التطوير التفاعلية والتنفيذ الطويل المستقل لمهام الهندسة المعقدة....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.2-codex",
            "canonicalSlug": "openai/gpt-5.2-codex-20260114",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000175",
                "completion": "0.000014",
                "web_search": "0.01",
                "input_cache_read": "0.000000175"
            },
            "created": 1768409315,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.3-codex",
        "name": "GPT-5.3-Codex",
        "description": "GPT-5.3-Codex is OpenAIâ€™s most advanced agentic coding model, combining the frontier software engineering performance of GPT-5.2-Codex with the broader reasoning and professional knowledge capabilities of GPT-5.2. It achieves state-of-the-art results...",
        "descriptionAr": "GPT-5.3-كوديكس هو أكثر نماذج البرمجة الوكيل تقدماً من أوبن إي آي، يجمع أداء الهندسة البرمجية الحدودي لـ GPT-5.2-كوديكس مع قدرات الاستدلال الأوسع والمعرفة المهنية لـ GPT-5.2. يحقق نتائج متطورة في...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.3-codex",
            "canonicalSlug": "openai/gpt-5.3-codex-20260224",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000175",
                "completion": "0.000014",
                "web_search": "0.01",
                "input_cache_read": "0.000000175"
            },
            "created": 1771959164,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.4",
        "name": "GPT-5.4",
        "description": "GPT-5.4 is OpenAIâ€™s latest frontier model, unifying the Codex and GPT lines into a single system. It features a 1M+ token context window (922K input, 128K output) with support for...",
        "descriptionAr": "GPT-5.4 هو أحدث نموذج حدودي من أوبن إي آي، يوحد خطوط كوديكس وGPT في نظام واحد. يتميز بنافذة سياق بـ 1 مليون+ رمز (922 ألف إدخال، 128 ألف إخراج) مع دعم لـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.4",
            "canonicalSlug": "openai/gpt-5.4-20260305",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.00000025",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.000005",
                        "completion": "0.0000225",
                        "input_cache_read": "0.0000005"
                    }
                ]
            },
            "created": 1772734352,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.4-image-2",
        "name": "GPT-5.4 Image 2",
        "description": "[GPT-5.4](https://openrouter.ai/openai/gpt-5.4) Image 2 combines OpenAI's GPT-5.4 model with state-of-the-art image generation capabilities from GPT Image 2. It enables rich multimodal workflows, allowing users to seamlessly move between reasoning, coding, and...",
        "descriptionAr": "[GPT-5.4](https://openrouter.ai/openai/gpt-5.4) إيميج 2 يجمع نموذج GPT-5.4 من أوبن إي آي مع قدرات توليد صور متطورة من GPT إيميج 2. يمكّن سير عمل متعدد الوسائط الغني، مما يسمح للمستخدمين بالتنقل بسلاسة بين الاستدلال والبرمجة و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "image",
                "text"
            ],
            "modality": "text+image+file->text+image"
        },
        "contextWindow": {
            "maxInputTokens": 272000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "openai/gpt-5.4-image-2",
            "canonicalSlug": "openai/gpt-5.4-image-2-20260421",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "top_logprobs"
            ],
            "pricing": {
                "prompt": "0.000008",
                "completion": "0.000015",
                "image_output": "0.00003",
                "web_search": "0.01",
                "input_cache_read": "0.000002"
            },
            "created": 1776797528,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini",
        "description": "GPT-5.4 mini brings the core capabilities of GPT-5.4 to a faster, more efficient model optimized for high-throughput workloads. It supports text and image inputs with strong performance across reasoning, coding,...",
        "descriptionAr": "يُجلب GPT-5.4 ميني القدرات الأساسية لـ GPT-5.4 إلى نموذج أسرع وأكثر كفاءة محسّن لأحمال العمل عالية الإنتاجية. يدعم مدخلات النص والصورة مع أداء قوي عبر الاستدلال، والبرمجة،...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.4-mini",
            "canonicalSlug": "openai/gpt-5.4-mini-20260317",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00000075",
                "completion": "0.0000045",
                "web_search": "0.01",
                "input_cache_read": "0.000000075"
            },
            "created": 1773748178,
            "knowledgeCutoff": "2025-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano",
        "description": "GPT-5.4 nano is the most lightweight and cost-efficient variant of the GPT-5.4 family, optimized for speed-critical and high-volume tasks. It supports text and image inputs and is designed for low-latency...",
        "descriptionAr": "GPT-5.4 نانو هو أكثر متغيرات عائلة GPT-5.4 خفةً وكفاءةً من حيث التكلفة، محسّن للمهام الحرجة من حيث السرعة وعالية الحجم. يدعم مدخلات النص والصورة ومصمم لبيئات الكمون المنخفض...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.4-nano",
            "canonicalSlug": "openai/gpt-5.4-nano-20260317",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000002",
                "completion": "0.00000125",
                "web_search": "0.01",
                "input_cache_read": "0.00000002"
            },
            "created": 1773748187,
            "knowledgeCutoff": "2025-08-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.4-pro",
        "name": "GPT-5.4 Pro",
        "description": "GPT-5.4 Pro is OpenAI's most advanced model, building on GPT-5.4's unified architecture with enhanced reasoning capabilities for complex, high-stakes tasks. It features a 1M+ token context window (922K input, 128K...",
        "descriptionAr": "GPT-5.4 برو هو أكثر نماذج أوبن إي آي تقدماً، يبنى على بنية GPT-5.4 الموحدة بقدرات استدلال محسنة للمهام المعقدة عالية المخاطر. يتميز بنافذة سياق بـ 1 مليون+ رمز (922 ألف إدخال، 128 ألف...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.4-pro",
            "canonicalSlug": "openai/gpt-5.4-pro-20260305",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00003",
                "completion": "0.00018",
                "web_search": "0.01",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.00006",
                        "completion": "0.00027"
                    }
                ]
            },
            "created": 1772734366,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.5",
        "name": "GPT-5.5",
        "description": "GPT-5.5 is OpenAIâ€™s frontier model designed for complex professional workloads, building on GPT-5.4 with stronger reasoning, higher reliability, and improved token efficiency on hard tasks. It features a 1M+ token...",
        "descriptionAr": "GPT-5.5 هو النموذج الحدودي من أوبن إي آي مصمم لأحمال العمل المهنية المعقدة، يبنى على GPT-5.4 باستدلال أقوى، وموثوقية أعلى، وكفاءة رموز محسنة على المهام الصعبة. يتميز بـ 1 مليون+ رمز...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.5",
            "canonicalSlug": "openai/gpt-5.5-20260423",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000005",
                "completion": "0.00003",
                "web_search": "0.01",
                "input_cache_read": "0.0000005",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.00001",
                        "completion": "0.000045",
                        "input_cache_read": "0.000001"
                    }
                ]
            },
            "created": 1777051893,
            "knowledgeCutoff": "2025-12-01",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "description": "GPT-5.5 Pro is OpenAIâ€™s high-capability model optimized for deep reasoning and accuracy on complex, high-stakes workloads. It features a 1M+ token context window (922K input, 128K output) with support for...",
        "descriptionAr": "GPT-5.5 برو هو النموذج عالي القدرة من أوبن إي آي، محسّن للاستدلال العميق والدقة على أحمال العمل المعقدة عالية المخاطر. يتميز بنافذة سياق بـ 1 مليون+ رمز (922 ألف إدخال، 128 ألف إخراج) مع دعم لـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.5-pro",
            "canonicalSlug": "openai/gpt-5.5-pro-20260423",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00003",
                "completion": "0.00018",
                "web_search": "0.01",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.00006",
                        "completion": "0.00027"
                    }
                ]
            },
            "created": 1777051896,
            "knowledgeCutoff": "2025-12-01",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "description": "GPT-5.6 Luna is a fast, cost-efficient model in OpenAI's GPT-5.6 series. It is suited for high-volume, latency-sensitive tasks such as chat, classification, and lightweight agentic workflows, providing capable reasoning for...",
        "descriptionAr": "GPT-5.6 لونا هو نموذج سريع فعال من حيث التكلفة في سلسلة GPT-5.6 من أوبن إي آي. مناسب للمهام عالية الحجم والحساسة للكمون مثل الدردشة والتصنيف وسير العمل الوكيل الخفيف، ويوفر استدلالاً قادراً لـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-luna",
            "canonicalSlug": "openai/gpt-5.6-luna-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000002",
                "completion": "0.0000012",
                "web_search": "0.01",
                "input_cache_read": "0.00000002",
                "input_cache_write": "0.00000025",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.0000004",
                        "completion": "0.0000018",
                        "input_cache_read": "0.00000004",
                        "input_cache_write": "0.0000005"
                    }
                ]
            },
            "created": 1783590864,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-luna-pro",
        "name": "GPT-5.6 Luna Pro",
        "description": "GPT-5.6 Luna Pro is the same underlying model as [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.\n\nLearn more in OpenAI's docs: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "descriptionAr": "GPT-5.6 لونا برو هو نفس النموذج الأساسي مثل [GPT-5.6 لونا](https://openrouter.ai/openai/gpt-5.6-luna)، يُخدم مع ضبط `reasoning.mode` على `pro` للحصول على استجابات عالية الجودة في المهام المعقدة. تعلم المزيد في وثائق أوبن إي آي: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-luna-pro",
            "canonicalSlug": "openai/gpt-5.6-luna-pro-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000002",
                "completion": "0.0000012",
                "web_search": "0.01",
                "input_cache_read": "0.00000002",
                "input_cache_write": "0.00000025",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.0000004",
                        "completion": "0.0000018",
                        "input_cache_read": "0.00000004",
                        "input_cache_write": "0.0000005"
                    }
                ]
            },
            "created": 1783590867,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "description": "GPT-5.6 Sol is the flagship model in OpenAI's GPT-5.6 series. It is suited for complex reasoning, coding, and agentic workflows, and is particularly strong at command-line and multi-step coding tasks...",
        "descriptionAr": "GPT-5.6 سول هو النموذج الرائد في سلسلة GPT-5.6 من أوبن إي آي. مناسب للاستدلال المعقد، والبرمجة، وسير العمل الوكيل، وقوي بشكل خاص في سطر الأوامر ومهام البرمجة متعددة الخطوات...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-sol",
            "canonicalSlug": "openai/gpt-5.6-sol-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.00000025",
                "input_cache_write": "0.000003125",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.000005",
                        "completion": "0.0000225",
                        "input_cache_read": "0.0000005",
                        "input_cache_write": "0.00000625"
                    }
                ]
            },
            "created": 1783590850,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-sol-pro",
        "name": "GPT-5.6 Sol Pro",
        "description": "GPT-5.6 Sol Pro is the same underlying model as [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.\n\nLearn more in OpenAI's docs: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "descriptionAr": "GPT-5.6 سول برو هو نفس النموذج الأساسي مثل [GPT-5.6 سول](https://openrouter.ai/openai/gpt-5.6-sol)، يُخدم مع ضبط `reasoning.mode` على `pro` للحصول على استجابات عالية الجودة في المهام المعقدة. تعلم المزيد في وثائق أوبن إي آي: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-sol-pro",
            "canonicalSlug": "openai/gpt-5.6-sol-pro-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000025",
                "completion": "0.000015",
                "web_search": "0.01",
                "input_cache_read": "0.00000025",
                "input_cache_write": "0.000003125",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.000005",
                        "completion": "0.0000225",
                        "input_cache_read": "0.0000005",
                        "input_cache_write": "0.00000625"
                    }
                ]
            },
            "created": 1783590854,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "description": "GPT-5.6 Terra is a balanced model in OpenAI's GPT-5.6 series, positioned between the flagship Sol tier and the cost-efficient Luna tier. It is suited for everyday coding, reasoning, and agentic...",
        "descriptionAr": "GPT-5.6 تيرا هو نموذج متوازن في سلسلة GPT-5.6 من أوبن إي آي، يضع نفسه بين مستوى سول الرائد ومستوى لونا الفعال من حيث التكلفة. مناسب للبرمجة اليومية، والاستدلال، والوكيل...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-terra",
            "canonicalSlug": "openai/gpt-5.6-terra-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "web_search": "0.01",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.0000025",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.000004",
                        "completion": "0.000018",
                        "input_cache_read": "0.0000004",
                        "input_cache_write": "0.000005"
                    }
                ]
            },
            "created": 1783590857,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-5.6-terra-pro",
        "name": "GPT-5.6 Terra Pro",
        "description": "GPT-5.6 Terra Pro is the same underlying model as [GPT-5.6 Terra](https://openrouter.ai/openai/gpt-5.6-terra), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.\n\nLearn more in OpenAI's docs: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "descriptionAr": "GPT-5.6 تيرا برو هو نفس النموذج الأساسي مثل [GPT-5.6 تيرا](https://openrouter.ai/openai/gpt-5.6-terra)، يُخدم مع ضبط `reasoning.mode` على `pro` للحصول على استجابات عالية الجودة في المهام المعقدة. تعلم المزيد في وثائق أوبن إي آي: https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "file",
                "image",
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 1050000,
            "maxOutputTokens": 128000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-5.6-terra-pro",
            "canonicalSlug": "openai/gpt-5.6-terra-pro-20260709",
            "supportedParameters": [
                "include_reasoning",
                "max_completion_tokens",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000012",
                "web_search": "0.01",
                "input_cache_read": "0.0000002",
                "input_cache_write": "0.0000025",
                "overrides": [
                    {
                        "min_prompt_tokens": 272000,
                        "prompt": "0.000004",
                        "completion": "0.000018",
                        "input_cache_read": "0.0000004",
                        "input_cache_write": "0.000005"
                    }
                ]
            },
            "created": 1783590861,
            "knowledgeCutoff": "2026-02-16",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-oss-120b",
        "name": "gpt-oss-120b",
        "description": "gpt-oss-120b is an open-weight, 117B-parameter Mixture-of-Experts (MoE) language model from OpenAI designed for high-reasoning, agentic, and general-purpose production use cases. It activates 5.1B parameters per forward pass and is optimized...",
        "descriptionAr": "gpt-oss-120b هو نموذج لغوي مزيج الخبراء (MoE) مفتوح الوزن بـ 117 مليار معامل من أوبن إي آي، مصمم لحالات الاستخدام الإنتاجية عالية الاستدلال والوكيلية والعامة. ينشط 5.1 مليار معامل لكل تمرير أمامي ومحسّن...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 131072
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-oss-120b",
            "canonicalSlug": "openai/gpt-oss-120b",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_a",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000003",
                "completion": "0.00000017",
                "input_cache_read": "0.00000003"
            },
            "created": 1754414231,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-oss-20b",
        "name": "gpt-oss-20b",
        "description": "gpt-oss-20b is an open-weight 21B parameter model released by OpenAI under the Apache 2.0 license. It uses a Mixture-of-Experts (MoE) architecture with 3.6B active parameters per forward pass, optimized for...",
        "descriptionAr": "gpt-oss-20b هو نموذج مفتوح الوزن بـ 21 مليار معامل أصدره أوبن إي آي بموجب ترخيص أباتشي 2.0. يستخدم بنية مزيج الخبراء (MoE) بـ 3.6 مليار معامل نشط لكل تمرير أمامي، محسّن لـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 131072
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-oss-20b",
            "canonicalSlug": "openai/gpt-oss-20b",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logit_bias",
                "logprobs",
                "max_tokens",
                "min_p",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.00000003",
                "completion": "0.00000013",
                "input_cache_read": "0.00000003"
            },
            "created": 1754414229,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-oss-20b:free",
        "name": "gpt-oss-20b (free)",
        "description": "gpt-oss-20b is an open-weight 21B parameter model released by OpenAI under the Apache 2.0 license. It uses a Mixture-of-Experts (MoE) architecture with 3.6B active parameters per forward pass, optimized for...",
        "descriptionAr": "gpt-oss-20b هو نموذج مفتوح الوزن بـ 21 مليار معامل أصدره أوبن إي آي بموجب ترخيص أباتشي 2.0. يستخدم بنية مزيج الخبراء (MoE) بـ 3.6 مليار معامل نشط لكل تمرير أمامي، محسّن لـ...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 32768
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-oss-20b:free",
            "canonicalSlug": "openai/gpt-oss-20b",
            "supportedParameters": [
                "frequency_penalty",
                "include_reasoning",
                "logprobs",
                "max_tokens",
                "presence_penalty",
                "reasoning",
                "reasoning_effort",
                "repetition_penalty",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_k",
                "top_logprobs",
                "top_p"
            ],
            "pricing": {
                "prompt": "0",
                "completion": "0"
            },
            "created": 1754414229,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "gpt-oss-safeguard-20b",
        "name": "gpt-oss-safeguard-20b",
        "description": "gpt-oss-safeguard-20b is a safety reasoning model from OpenAI built upon gpt-oss-20b. This open-weight, 21B-parameter Mixture-of-Experts (MoE) model offers lower latency for safety tasks like content classification, LLM filtering, and trust...",
        "descriptionAr": "gpt-oss-safeguard-20b هو نموذج استدلال أمان من أوبن إي آي مبني على gpt-oss-20b. هذا النموذج المفتوح الوزن، المكون من 21 مليار معامل ومزيج الخبراء (MoE) يوفر كموناً أقل لمهام الأمان مثل تصنيف المحتوى، وتصفية LLM، والثقة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 131072,
            "maxOutputTokens": 65536
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/gpt-oss-safeguard-20b",
            "canonicalSlug": "openai/gpt-oss-safeguard-20b",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "stop",
                "structured_outputs",
                "temperature",
                "tool_choice",
                "tools",
                "top_p"
            ],
            "pricing": {
                "prompt": "0.000000075",
                "completion": "0.0000003",
                "input_cache_read": "0.0000000375"
            },
            "created": 1761752836,
            "knowledgeCutoff": null,
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o1",
        "name": "o1",
        "description": "The latest and strongest model family from OpenAI, o1 is designed to spend more time thinking before responding. The o1 model series is trained with large-scale reinforcement learning to reason...",
        "descriptionAr": "أحدث وأقوى عائلة نماذج من أوبن إي آي، o1 مصمم لقضاء وقت أطول في التفكير قبل الرد. يتم تدريب سلسلة نماذج o1 باستخدام التعلم المعزز واسع النطاق للاستدلال...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o1",
            "canonicalSlug": "openai/o1-2024-12-17",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000015",
                "completion": "0.00006",
                "web_search": "0.01",
                "input_cache_read": "0.0000075"
            },
            "created": 1734459999,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o1-pro",
        "name": "o1-pro",
        "description": "The o1 series of models are trained with reinforcement learning to think before they answer and perform complex reasoning. The o1-pro model uses more compute to think harder and provide...",
        "descriptionAr": "يتم تدريب سلسلة نماذج o1 باستخدام التعلم المعزز للتفكير قبل الإجابة وأداء الاستدلال المعقد. يستخدم نموذج o1-pro المزيد من القوة الحسابية للتفكير بشكل أعمق وتقديم...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "image",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": false,
        "metadata": {
            "openRouterId": "openai/o1-pro",
            "canonicalSlug": "openai/o1-pro",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs"
            ],
            "pricing": {
                "prompt": "0.00015",
                "completion": "0.0006",
                "web_search": "0.01"
            },
            "created": 1742423211,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o3",
        "name": "o3",
        "description": "o3 is a well-rounded and powerful model across domains. It sets a new standard for math, science, coding, and visual reasoning tasks. It also excels at technical writing and instruction-following....",
        "descriptionAr": "o3 هو نموذج شامل وقوي عبر المجالات. يضع معياراً جديداً للرياضيات والعلوم والبرمجة ومهام الاستدلال البصري. كما يمتاز في الكتابة التقنية واتباع التعليمات....",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o3",
            "canonicalSlug": "openai/o3-2025-04-16",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000008",
                "web_search": "0.01",
                "input_cache_read": "0.0000005"
            },
            "created": 1744823457,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o3-mini",
        "name": "o3 Mini",
        "description": "OpenAI o3-mini is a cost-efficient language model optimized for STEM reasoning tasks, particularly excelling in science, mathematics, and coding. This model supports the `reasoning_effort` parameter, which can be set to...",
        "descriptionAr": "أوبن إي آي o3-mini هو نموذج لغوي فعال من حيث التكلفة محسّن لمهام الاستدلال في العلوم والتكنولوجيا والهندسة والرياضيات (STEM)، ويتفوق بشكل خاص في العلوم والرياضيات والبرمجة. يدعم هذا النموذج معلمة `reasoning_effort`، التي يمكن ضبطها على...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o3-mini",
            "canonicalSlug": "openai/o3-mini-2025-01-31",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000011",
                "completion": "0.0000044",
                "web_search": "0.01",
                "input_cache_read": "0.00000055"
            },
            "created": 1738351721,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o3-mini-high",
        "name": "o3 Mini High",
        "description": "OpenAI o3-mini-high is the same model as [o3-mini](/openai/o3-mini) with reasoning_effort set to high. o3-mini is a cost-efficient language model optimized for STEM reasoning tasks, particularly excelling in science, mathematics, and...",
        "descriptionAr": "أوبن إي آي o3-mini-high هو نفس النموذج مثل [o3-mini](/openai/o3-mini) مع ضبط reasoning_effort على high. o3-mini هو نموذج لغوي فعال من حيث التكلفة محسّن لمهام الاستدلال في العلوم والتكنولوجيا والهندسة والرياضيات (STEM)، ويتفوق بشكل خاص في العلوم والرياضيات و...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o3-mini-high",
            "canonicalSlug": "openai/o3-mini-high-2025-01-31",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000011",
                "completion": "0.0000044",
                "web_search": "0.01",
                "input_cache_read": "0.00000055"
            },
            "created": 1739372611,
            "knowledgeCutoff": "2023-10-31",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o3-pro",
        "name": "o3 Pro",
        "description": "The o-series of models are trained with reinforcement learning to think before they answer and perform complex reasoning. The o3-pro model uses more compute to think harder and provide consistently...",
        "descriptionAr": "يتم تدريب سلسلة النماذج o باستخدام التعلم المعزز للتفكير قبل الإجابة وأداء الاستدلال المعقد. يستخدم نموذج o3-pro المزيد من القوة الحسابية للتفكير بشكل أعمق وتقديم استجابات متسقة...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "text",
                "file",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o3-pro",
            "canonicalSlug": "openai/o3-pro-2025-06-10",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.00002",
                "completion": "0.00008",
                "web_search": "0.01"
            },
            "created": 1749598352,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o4-mini",
        "name": "o4 Mini",
        "description": "OpenAI o4-mini is a compact reasoning model in the o-series, optimized for fast, cost-efficient performance while retaining strong multimodal and agentic capabilities. It supports tool use and demonstrates competitive reasoning...",
        "descriptionAr": "أوبن إي آي o4-mini هو نموذج استدلال مضغوط في السلسلة o، محسّن لأداء سريع فعال من حيث التكلفة مع الحفاظ على قدرات متعددة الوسائط ووكيلية قوية. يدعم استخدام الأدوات ويُظهر استدلالاً تنافسياً...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o4-mini",
            "canonicalSlug": "openai/o4-mini-2025-04-16",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000011",
                "completion": "0.0000044",
                "web_search": "0.01",
                "input_cache_read": "0.000000275"
            },
            "created": 1744820942,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "openai",
        "modelCode": "o4-mini-high",
        "name": "o4 Mini High",
        "description": "OpenAI o4-mini-high is the same model as [o4-mini](/openai/o4-mini) with reasoning_effort set to high. OpenAI o4-mini is a compact reasoning model in the o-series, optimized for fast, cost-efficient performance while retaining...",
        "descriptionAr": "أوبن إي آي o4-mini-high هو نفس النموذج مثل [o4-mini](/openai/o4-mini) مع ضبط reasoning_effort على high. أوبن إي آي o4-mini هو نموذج استدلال مضغوط في السلسلة o، محسّن لأداء سريع فعال من حيث التكلفة مع الحفاظ على...",
        "modelType": AiModelType.TEXT,
        "tier": null,

        "modalities": {
            "input": [
                "image",
                "text",
                "file"
            ],
            "output": [
                "text"
            ],
            "modality": "text+image+file->text"
        },
        "contextWindow": {
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "openRouterId": "openai/o4-mini-high",
            "canonicalSlug": "openai/o4-mini-high-2025-04-16",
            "supportedParameters": [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
                "response_format",
                "seed",
                "structured_outputs",
                "tool_choice",
                "tools"
            ],
            "pricing": {
                "prompt": "0.0000011",
                "completion": "0.0000044",
                "web_search": "0.01",
                "input_cache_read": "0.000000275"
            },
            "created": 1744824212,
            "knowledgeCutoff": "2024-06-30",
            "expirationDate": null
        }
    },
    {
        "provider": "llm7",
        "modelCode": "codestral-latest",
        "name": "codestral-latest",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 32000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "codestral-latest",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.01,
                "output": 0.02,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": false,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 99.94,
            "availability": {
                "old": 99.91,
                "mid": 99.91,
                "recent": 100.0
            },
            "created": 1787056175
        }
    },
    {
        "provider": "llm7",
        "modelCode": "deepseek-v3",
        "name": "deepseek-v3",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 1048576,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": false,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "deepseek-v3",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.01,
                "output": 0.02,
                "cached_input": 0.01,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": true,
                "json_mode": false,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 77.88,
            "availability": {
                "old": 83.33,
                "mid": 73.53,
                "recent": 78.85
            },
            "created": 1787057608
        }
    },
    {
        "provider": "llm7",
        "modelCode": "DeepSeek-V4-Flash-0731",
        "name": "DeepSeek-V4-Flash-0731",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 400000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "DeepSeek-V4-Flash-0731",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.02,
                "output": 0.04,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": true,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 99.51,
            "availability": {
                "old": 100.0,
                "mid": 98.96,
                "recent": 99.51
            },
            "created": 1787057607
        }
    },
    {
        "provider": "llm7",
        "modelCode": "gemini-3.1-flash-lite",
        "name": "gemini-3.1-flash-lite",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text",
                "image"
            ],
            "output": [
                "text"
            ],
            "modality": null
        },
        "contextWindow": {
            "maxInputTokens": 256000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "gemini-3.1-flash-lite",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.02,
                "output": 0.04,
                "cached_input": 0.02,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": true,
                "tools": true,
                "reasoning": false,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 100.0,
            "availability": {
                "old": 100.0,
                "mid": 100.0,
                "recent": 100.0
            },
            "created": 1787057607
        }
    },
    {
        "provider": "llm7",
        "modelCode": "gemma4:31b",
        "name": "gemma4:31b",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 262000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "gemma4:31b",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.03,
                "output": 0.08,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": true,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": false,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 93.33,
            "availability": {
                "old": 85.71,
                "mid": 100.0,
                "recent": 100.0
            },
            "created": 1787057421
        }
    },
    {
        "provider": "llm7",
        "modelCode": "gpt-oss:20b",
        "name": "gpt-oss:20b",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "gpt-oss:20b",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.04,
                "output": 0.06,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": false,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 99.62,
            "availability": {
                "old": 98.88,
                "mid": 100.0,
                "recent": 100.0
            },
            "created": 1787057421
        }
    },
    {
        "provider": "llm7",
        "modelCode": "minimax-m2.7",
        "name": "minimax-m2.7",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 180000,
            "maxOutputTokens": null
        },
        "stream": false,
        "jsonMode": true,
        "reasoning": true,
        "toolsCalling": true,
        "metadata": {
            "llm7Id": "minimax-m2.7",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.03,
                "output": 0.05,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": true,
                "reasoning": true,
                "json_mode": true,
                "stream": false,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 99.54,
            "availability": {
                "old": 100.0,
                "mid": 98.98,
                "recent": 99.57
            },
            "created": 1787057607
        }
    },
    {
        "provider": "llm7",
        "modelCode": "mistral-Nemo-Instruct-2407",
        "name": "mistral-Nemo-Instruct-2407",
        "description": null,
        "descriptionAr": null,
        "modelType": AiModelType.TEXT,
        "tier": AiModelTier.FREE,
        "batch": false,
        "modalities": {
            "input": [
                "text"
            ],
            "output": [
                "text"
            ],
            "modality": "text->text"
        },
        "contextWindow": {
            "maxInputTokens": 128000,
            "maxOutputTokens": null
        },
        "stream": true,
        "jsonMode": true,
        "reasoning": false,
        "toolsCalling": false,
        "metadata": {
            "llm7Id": "mistral-Nemo-Instruct-2407",
            "object": "model",
            "ownedBy": "",
            "modelType": "chat",
            "schemaEndpoints": [
                "openai"
            ],
            "pricingMode": "token",
            "pricing": {
                "input": 0.03,
                "output": 0.03,
                "currency": "USD",
                "unit": "1M tokens"
            },
            "usageBasedOnly": false,
            "capabilities": {
                "vision": false,
                "tools": false,
                "reasoning": false,
                "json_mode": true,
                "stream": true,
                "supported_seconds": [],
                "supported_sizes": [],
                "supported_image_mime_types": [],
                "requires_reference_image": false,
                "atlascloud_routes": []
            },
            "availabilityLastHourPercent": 100.0,
            "availability": {
                "old": 100.0,
                "mid": 100.0,
                "recent": 100.0
            },
            "created": 1787057484
        }
    }
];

const AI_PROVIDER_SEEDS = [
    {
        code: AiProviderCode.OPENAI,
        name: 'OpenAI',
        website: 'https://openai.com',
        logoUrl: '/ai-providers/chatgpt.png',
        description:
            'Advanced AI models for chat, reasoning, coding, content generation, and tool calling.',
        descriptionAr:
            'نماذج ذكاء اصطناعي متقدمة للمحادثة والاستدلال والبرمجة وإنشاء المحتوى واستدعاء الأدوات.',
        scope: AiEntityScope.SYSTEM,

        tenantIntegrationAllowed: true,
        isActive: true,

        protocol: AiProviderProtocol.OPENAI_COMPATIBLE,
        authType: AiAuthType.BEARER,
    },

    {
        code: AiProviderCode.ANTHROPIC,
        name: 'Anthropic',
        website: 'https://www.anthropic.com',
        logoUrl: '/ai-providers/anthropic.png',
        description:
            'AI models built for reliable reasoning, coding, analysis, and safe conversational experiences.',
        descriptionAr:
            'نماذج ذكاء اصطناعي مصممة للاستدلال الموثوق والبرمجة والتحليل وتجارب المحادثة الآمنة.',
        scope: AiEntityScope.SYSTEM,

        tenantIntegrationAllowed: true,
        isActive: true,

        protocol: null,
        authType: AiAuthType.API_KEY,
    },

    {
        code: AiProviderCode.GOOGLE,
        name: 'Google',
        website: 'https://ai.google.dev',
        logoUrl: '/ai-providers/gemini.png',
        description:
            'Google AI models for multimodal understanding, reasoning, coding, and content generation.',
        descriptionAr:
            'نماذج الذكاء الاصطناعي من Google لفهم المحتوى متعدد الوسائط والاستدلال والبرمجة وإنشاء المحتوى.',
        scope: AiEntityScope.SYSTEM,

        tenantIntegrationAllowed: true,
        isActive: true,

        protocol: null,
        authType: AiAuthType.API_KEY,
    },

    {
        code: AiProviderCode.DEEPSEEK,
        name: 'DeepSeek',
        website: 'https://www.deepseek.com',
        logoUrl: '/ai-providers/deepseek.svg',
        description:
            'High-performance AI models focused on reasoning, coding, and general-purpose tasks.',
        descriptionAr:
            'نماذج ذكاء اصطناعي عالية الأداء تركز على الاستدلال والبرمجة والمهام العامة.',
        scope: AiEntityScope.SYSTEM,

        tenantIntegrationAllowed: true,
        isActive: true,

        protocol: AiProviderProtocol.OPENAI_COMPATIBLE,
        authType: AiAuthType.BEARER,
    },

    {
        code: AiProviderCode.LLM7,
        name: 'LLM7',
        website: 'https://llm7.io',
        logoUrl: '/ai-providers/llm7.avif',
        description:
            'A unified AI gateway providing access to multiple language models through a single API.',
        descriptionAr:
            'بوابة موحدة للذكاء الاصطناعي تتيح الوصول إلى نماذج لغوية متعددة من خلال واجهة API واحدة.',
        scope: AiEntityScope.SYSTEM,

        // Users/tenants do not configure LLM7 themselves.
        tenantIntegrationAllowed: false,
        isActive: false,

        protocol: AiProviderProtocol.OPENAI_COMPATIBLE,
        authType: AiAuthType.BEARER,
    },

    {
        code: AiProviderCode.POLLINATIONS,
        name: 'Pollinations',
        website: 'https://pollinations.ai',
        logoUrl: '/ai-providers/pollinations.svg',
        description:
            'An AI platform providing access to text and image generation models through simple APIs.',
        descriptionAr:
            'منصة ذكاء اصطناعي توفر الوصول إلى نماذج إنشاء النصوص والصور من خلال واجهات API بسيطة.',
        scope: AiEntityScope.SYSTEM,

        // Users/tenants do not configure Pollinations themselves.
        tenantIntegrationAllowed: false,
        isActive: false,

        protocol: AiProviderProtocol.OPENAI_COMPATIBLE,
        authType: AiAuthType.BEARER,
    },
] as const;

export async function seedAiModels() {
    console.log('ðŸŒ± Seeding AI providers...');
    const repository = dataSource.getRepository(AiProviderEntity);

    for (const provider of AI_PROVIDER_SEEDS) {
        const existing = await repository.findOne({
            where: {
                code: provider.code,
            },
        });

        if (existing) {
            await repository.update(existing.id, {
                name: provider.name,
                website: provider.website,
                logoUrl: provider.logoUrl,
                description: provider.description,
                descriptionAr: provider.descriptionAr,
                scope: provider.scope,
                tenantIntegrationAllowed:
                    provider.tenantIntegrationAllowed,
                isActive: provider.isActive,
                protocol: provider.protocol,
                authType: provider.authType,
            });

            continue;
        }

        await repository.save(
            repository.create({
                code: provider.code,
                name: provider.name,
                website: provider.website,
                logoUrl: provider.logoUrl,
                description: provider.description,

                scope: provider.scope,

                adminId: null,

                tenantIntegrationAllowed:
                    provider.tenantIntegrationAllowed,

                isActive: provider.isActive,

                protocol: provider.protocol,

                authType: provider.authType,
            }),
        );
    }

    console.log(
        `âœ… AI providers seeded: ${AI_PROVIDER_SEEDS.length}`,
    );

    console.log('ðŸŒ± Seeding AI models...');

    const providerRepo = dataSource.getRepository(AiProviderEntity);
    const modelRepo = dataSource.getRepository(AiModelEntity);

    for (const model of AI_MODEL_SEEDS) {
        const provider = await providerRepo.findOne({
            where: {
                code: model.provider,
            },
        });

        if (!provider) {
            console.warn(`âš ï¸ Provider not found: ${model.provider}`);
            continue;
        }

        await modelRepo.upsert(
            {
                scope: AiEntityScope.SYSTEM,
                providerId: provider.id,
                modelCode: model.modelCode,
                name: model.name,
                modelType: model.modelType,
                tier: model.tier,
                description: model.description,
                descriptionAr: model.descriptionAr,
                modalities: model.modalities as Record<string, any>,
                contextWindow: model.contextWindow as Record<string, any>,
                stream: model.stream,
                jsonMode: model.jsonMode,
                reasoning: model.reasoning,
                toolsCalling: model.toolsCalling,
                metadata: model.metadata as Record<string, any>,
                isActive: true,
            },
            ['providerId', 'modelCode'],
        );
    }

    console.log(`âœ… Seeded ${AI_MODEL_SEEDS.length} AI models`);
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

        case 'models':
            await seedAiModels();
            break;

        case 'all':
        case undefined:
            console.log('ðŸŒ± Running global seeders...');
            await seedOrderStatuses();
            await seedLocations();
            await seedSuperAdmin();
            await seedCategories();
            await seedWarehouses();
            await seedGettingStarted();
            console.log('âœ… Global seed completed');
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
        console.error('âŒ Seeder failed', err);
        process.exit(1);
    });
