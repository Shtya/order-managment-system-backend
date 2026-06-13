import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateFilterUtil } from 'common/date-filter.util';
import { AutoAssignDto, AutoPreviewDto, CreateAutoAssignRuleDto, GetFreeOrdersDto, ManualAssignManyDto, UpdateAutoAssignRuleDto } from 'dto/order-assignment.dto';
import { OrderAssignmentEntity, AutoAssignRuleEntity, AutoAssignRuleType, AssignmentStrategy, WeekDay } from 'entities/assignment.entity';
import { OrderEntity, OrderStatus, OrderStatusEntity, AssignmentMode, TimeUnit } from 'entities/order.entity';
import { User } from 'entities/user.entity';
import { tenantId } from 'src/category/category.service';
import { OrdersService } from 'src/orders/services/orders.service';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import * as ExcelJS from "exceljs";
import { ProductEntity } from 'entities/sku.entity';
import { CityEntity } from 'entities/cities.entity';
import { ShippingCompanyEntity } from 'entities/shipping.entity';
import { autoAssignmentQueue } from './queues';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { BitmaskHelper, WeekDayHelper } from 'common/bitmask.helper';
import { StoreEntity } from 'entities/stores.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class OrderAssignmentService {
    constructor(
        @InjectRepository(OrderAssignmentEntity)
        private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
        @InjectRepository(AutoAssignRuleEntity)
        private readonly autoAssignRuleRepo: Repository<AutoAssignRuleEntity>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,

        private dataSource: DataSource,

        @InjectRepository(OrderEntity)
        private orderRepo: Repository<OrderEntity>,

        @InjectRepository(OrderStatusEntity)
        private statusRepo: Repository<OrderStatusEntity>,

        @InjectRepository(ProductEntity)
        private readonly productRepo: Repository<ProductEntity>,

        @InjectRepository(CityEntity)
        private readonly cityRepo: Repository<CityEntity>,

        @InjectRepository(ShippingCompanyEntity)
        private readonly shippingCompanyRepo: Repository<ShippingCompanyEntity>,

        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,

        @Inject(forwardRef(() => NotificationService))
        protected readonly notificationService: NotificationService,

        @InjectRepository(StoreEntity)
        private readonly storeRepo: Repository<StoreEntity>,
    ) { }

    async getEmployeesByLoad(me: any, limit: number = 20, cursor: number | null, role?: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const fetchLimit = Number(limit) || 20;

        const qb = this.userRepo
            .createQueryBuilder("user")
            .leftJoin("user.role", "role") // لتمكين الفلترة بالـ role
            .leftJoin(
                "user.assignments",
                "assignment",
                "assignment.isAssignmentActive = true",
            )
            .where("user.adminId = :adminId", { adminId })
            .select([
                "user.id",
                "user.name",
                "user.email",
                "user.avatarUrl",
                "user.employeeType",
                "user.isActive",
            ])
            .addSelect("COUNT(assignment.id)", "activeCount")
            .groupBy("user.id")
            .addGroupBy("role.id");

        if (role) {
            qb.andWhere("role.name = :role", { role });
        }

        if (cursor !== null && cursor !== undefined) {
            qb.having("COUNT(assignment.id) >= :cursor", { cursor });
        }

        qb.orderBy("COUNT(assignment.id)", "ASC")
            .addOrderBy("user.id", "ASC")
            .limit(fetchLimit + 1);

        const { entities, raw } = await qb.getRawAndEntities();

        const result = entities.map((u, i) => ({
            user: u,
            activeCount: parseInt(raw[i].activeCount, 10) || 0,
        }));

        const hasMore = result.length > fetchLimit;

        if (hasMore) {
            result.pop();
        }

        const nextCursor =
            hasMore && result.length > 0
                ? result[result.length - 1].activeCount
                : null;

        return {
            data: result,
            nextCursor,
            hasMore,
        };
    }



    async manualAssignMany(me: any, dto: ManualAssignManyDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");


        // collect all employee ids and all order ids from payload
        const employeeIds = [...new Set(dto.assignments.map((a) => a.userId))];
        const allOrderIds = [
            ...new Set(dto.assignments.flatMap((a) => a.orderIds)),
        ];

        // validate no duplicate order across different employees (already deduped above, but check in payload)
        const payloadOrderCount = dto.assignments.reduce(
            (sum, a) => sum + a.orderIds.length,
            0,
        );
        if (allOrderIds.length !== payloadOrderCount) {
            throw new BadRequestException(
                "Each order may only be assigned to a single employee in the same request",
            );
        }

        return this.dataSource.transaction(async (manager) => {
            // 1) verify employees exist & belong to admin
            const employees = await manager.find(User, {
                where: { id: In(employeeIds), adminId } as any,
            });

            if (employees.length !== employeeIds.length) {
                throw new NotFoundException(
                    `Employees not found or not belonging to admin`,
                );
            }

            // 2) verify orders exist & belong to admin
            const freeOrders = await manager
                .createQueryBuilder(OrderEntity, "order")
                .innerJoin("order.status", "status")
                .leftJoin(
                    "order.assignments",
                    "assignment",
                    "assignment.isAssignmentActive = :isActive",
                    { isActive: true },
                )
                .where("order.id IN (:...allOrderIds)", { allOrderIds })
                .andWhere("order.adminId = :adminId", { adminId })
                .andWhere("assignment.id IS NULL") // This ensures the order is "free"
                .select(["order.id", "order.orderNumber"])
                .getMany();

            for (const order of freeOrders) {
                if (order.status && !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(order.status.code as OrderStatus)) {
                    throw new BadRequestException(
                        `Order #${order.orderNumber} has status "${order.status.name}" which is not allowed for assignment. Allowed statuses: ${[...this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT].join(", ")}`,
                    );
                }
            }

            if (freeOrders.length !== allOrderIds.length) {
                throw new BadRequestException(
                    `Some orders are either invalid, restricted, or already actively assigned.`,
                );
            }

            freeOrders.forEach(async o => await this.ordersService.throwIfDelivered(o, "Cannot assign a order that has been closed."));
            // 4) fetch settings
            const settings = await this.ordersService.getSettings(me);
            const maxRetries = settings?.maxRetries || 3;

            // 5) create assignment entities in bulk
            const assignmentsToSave: OrderAssignmentEntity[] = [];

            for (const item of dto.assignments) {
                for (const orderId of item.orderIds) {
                    const assignment = manager.create(OrderAssignmentEntity, {
                        orderId,
                        employeeId: item.userId,
                        assignedByAdminId: adminId,
                        maxRetriesAtAssignment: maxRetries,
                        isAssignmentActive: true,
                    });
                    assignmentsToSave.push(assignment);
                }
            }

            // 6) save all assignments
            const saved = await manager.save(
                OrderAssignmentEntity,
                assignmentsToSave,
            );

            // return helpful summary
            const summary = {
                success: true,
                totalAssigned: saved.length,
                byEmployee: employees.map((emp) => {
                    const count = saved.filter((s) => s.employeeId === emp.id).length;
                    return {
                        userId: emp.id,
                        name: emp.name || null,
                        assignedCount: count,
                    };
                }),
            };

            return summary;
        });
    }

    async autoAssign(me: any, dto: AutoAssignDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        return this.dataSource.transaction(async (manager) => {
            // 1. Find 'Free' Orders (No active assignments)
            const q = manager
                .createQueryBuilder(OrderEntity, "order")
                .innerJoin("order.status", "status")
                .leftJoin(
                    "order.assignments",
                    "assignment",
                    "assignment.isAssignmentActive = :isActive",
                    { isActive: true },
                )
                .where("order.adminId = :adminId", { adminId })
                .andWhere("order.statusId IN (:...statusIds)", {
                    statusIds: dto.statusIds,
                })
                .andWhere("assignment.id IS NULL") // Only orders with NO active assignments
                .select(["order.id", "order.orderNumber"]);
            DateFilterUtil.applyToQueryBuilder(q, 'order.created_at', dto?.startDate, dto?.endDate);

            const freeOrders = await q.limit(dto.orderCount).getMany();

            for (const order of freeOrders) {
                if (order.status && !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(order.status.code as OrderStatus)) {
                    throw new BadRequestException(
                        `Order #${order.orderNumber} has status "${order.status.name}" which is not allowed for assignment. Allowed statuses: ${[...this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT].join(", ")}`,
                    );
                }
            }

            if (freeOrders.length === 0) {
                throw new NotFoundException(
                    "No free orders found matching these criteria",
                );
            }
            if (freeOrders.length !== dto.orderCount) {
                throw new BadRequestException(
                    `Cannot fulfill request. You requested ${dto.orderCount} orders, but only ${freeOrders.length} unassigned orders were found for the selected statuses.`,
                );
            }
            freeOrders.forEach(async o => await this.ordersService.throwIfDelivered(o, "Cannot assign a order that has been closed."));

            // 2. Find 'Least Busy' Employees
            // We count active assignments for each employee and sort ASC
            const employees = await manager
                .createQueryBuilder(User, "user")
                .leftJoin(
                    "order_assignments",
                    "oa",
                    "oa.employeeId = user.id AND oa.isAssignmentActive = true",
                )
                .where("user.adminId = :adminId", { adminId })
                // Add a role check here if necessary (e.g., .andWhere("user.role = 'employee'"))
                .select("user.id", "id")
                .addSelect("user.name", "name")
                .addSelect("COUNT(oa.id)", "activeCount")
                .groupBy("user.id")
                .orderBy("COUNT(oa.id)", "ASC")
                .limit(dto.employeeCount)
                .getRawMany();

            if (employees.length === 0) {
                throw new NotFoundException("No eligible employees found");
            }

            if (employees.length < dto.employeeCount) {
                throw new BadRequestException(
                    `Insufficient employees. You requested assignment to ${dto.employeeCount} employees, but only ${employees.length} are available.`,
                );
            }

            // 3. Fetch Settings
            const settings = await this.ordersService.getSettings(me);
            const maxRetries = settings?.maxRetries || 3;

            const assignmentsToSave: OrderAssignmentEntity[] = [];

            freeOrders.forEach((order, index) => {
                const employee = employees[index % employees.length]; // Cycle through employees

                const assignment = manager.create(OrderAssignmentEntity, {
                    orderId: order.id,
                    employeeId: employee.id,
                    assignedByAdminId: adminId,
                    maxRetriesAtAssignment: maxRetries,
                    isAssignmentActive: true,
                });
                assignmentsToSave.push(assignment);
            });

            // 5. Save and Summary
            const saved = await manager.save(
                OrderAssignmentEntity,
                assignmentsToSave,
            );

            return {
                success: true,
                totalAssigned: saved.length,
                employeesParticipating: employees.length,
                byEmployee: employees.map((emp) => ({
                    userId: emp.id,
                    name: emp.name,
                    previouslyActive: parseInt(emp.activeCount),
                    newlyAssigned: saved.filter((s) => s.employeeId === emp.id).length,
                })),
            };
        });
    }

    async getAutoPreview(me: any, dto: AutoPreviewDto) {
        const adminId = tenantId(me);

        // 1. Fetch TOTAL Max Limits (Ceilings) in Parallel
        const orderCountQuery = this.orderRepo
            .createQueryBuilder("order")
            .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
            .where("order.adminId = :adminId", { adminId })
            .andWhere("order.statusId IN (:...statusIds)", {
                statusIds: dto.statusIds,
            })
            .andWhere("oa.id IS NULL");
        DateFilterUtil.applyToQueryBuilder(orderCountQuery, 'order.created_at', dto?.startDate, dto?.endDate);


        const [maxOrdersCount, maxEmployeesCount] = await Promise.all([
            orderCountQuery.getCount(),
            this.userRepo.count({ where: { adminId } as any }),
        ]);

        // 2. Cap the requested counts to the Max Limits
        const effectiveOrderCount = Math.min(
            dto.requestedOrderCount || maxOrdersCount,
            maxOrdersCount,
        );
        const effectiveEmployeeCount = Math.min(
            dto.requestedEmployeeCount || maxEmployeesCount,
            maxEmployeesCount,
        );

        // If there's nothing to assign, return early
        if (effectiveOrderCount === 0 || effectiveEmployeeCount === 0) {
            return {
                maxOrders: maxOrdersCount,
                maxEmployees: maxEmployeesCount,
                assignments: [],
            };
        }
        // 3. Fetch specific Orders and Employees for the preview
        const [freeOrders, leastBusyEmployees] = await Promise.all([
            this.orderRepo
                .createQueryBuilder("order")
                .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
                .where("order.adminId = :adminId", { adminId })
                .andWhere("order.statusId IN (:...statusIds)", {
                    statusIds: dto.statusIds,
                })
                .andWhere("oa.id IS NULL")
                .select(["order.id", "order.orderNumber"])
                .limit(effectiveOrderCount)
                .getMany(),

            this.userRepo
                .createQueryBuilder("user")
                .leftJoin(
                    "order_assignments",
                    "oa",
                    "oa.employeeId = user.id AND oa.isAssignmentActive = true",
                )
                .where("user.adminId = :adminId", { adminId })
                .select(["user.id", "user.name"])
                .addSelect("COUNT(oa.id)", "activeCount")
                .groupBy("user.id")
                .orderBy("COUNT(oa.id)", "ASC")
                .limit(effectiveEmployeeCount)
                .getMany(),
        ]);
        // 4. In-Memory Round-Robin Assignment
        const assignmentMap = new Map<string, { name: string; orderNumbers: string[] }>();

        // Initialize map with selected employees
        leastBusyEmployees.forEach((emp) => {
            assignmentMap.set(emp.id, { name: emp.name, orderNumbers: [] });
        });

        // Distribute orders
        freeOrders.forEach((order, index) => {
            const employee = leastBusyEmployees[index % leastBusyEmployees.length];
            assignmentMap.get(employee.id).orderNumbers.push(order.orderNumber);
        });

        return {
            maxOrders: maxOrdersCount,
            maxEmployees: maxEmployeesCount,
            effectiveEmployeeCount,
            effectiveOrderCount,
            assignments: Array.from(assignmentMap.values()),
        };
    }


    async listMyAssignedOrders(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const myUserId = me?.id;
        if (!myUserId) throw new BadRequestException("Missing user ID");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.orderRepo
            .createQueryBuilder("order")
            .where("order.adminId = :adminId", { adminId })

            // 🔥 IMPORTANT: only my active assignments
            .innerJoinAndSelect(
                "order.assignments",
                "assignment",
                "assignment.isAssignmentActive = true AND assignment.employeeId = :myUserId",
                { myUserId },
            )

            .leftJoinAndSelect("order.items", "items")
            .leftJoinAndSelect("items.variant", "variant")
            .leftJoinAndSelect("variant.product", "product")
            .leftJoinAndSelect("order.status", "status")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoinAndSelect("order.store", "store")
            .leftJoinAndSelect("assignment.employee", "employee");

        // Allowed sorting columns
        const sortColumns: Record<string, string> = {
            createdAt: "order.created_at",
            orderNumber: "order.orderNumber",
        };

        // Filters
        if (q?.status) {
            const statusParam = q.status;
            if (!isNaN(Number(statusParam))) {
                qb.andWhere("order.statusId = :statusId", {
                    statusId: Number(statusParam),
                });
            } else {
                qb.andWhere("status.code = :statusCode", {
                    statusCode: String(statusParam).trim(),
                });
            }
        }
        if (q?.type) {
            qb.andWhere("order.type = :type", { type: q.type });
        }
        if (q?.paymentStatus)
            qb.andWhere("order.paymentStatus = :paymentStatus", {
                paymentStatus: q.paymentStatus,
            });

        if (q?.paymentMethod)
            qb.andWhere("order.paymentMethod = :paymentMethod", {
                paymentMethod: q.paymentMethod,
            });

        if (q?.shippingCompanyId)
            qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
                shippingCompanyId: q.shippingCompanyId,
            });

        if (q?.storeId)
            qb.andWhere("order.storeId = :storeId", {
                storeId: q.storeId,
            });

        // Date range
        DateFilterUtil.applyToQueryBuilder(qb, "order.created_at", q?.startDate, q?.endDate);

        // Search
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
                        .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // Sorting
        if (sortColumns[sortBy]) {
            qb.orderBy(sortColumns[sortBy], sortDir);
        } else {
            qb.orderBy("order.created_at", "DESC");
        }

        const total = await qb.getCount();

        const records = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getMany();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
        };
    }

    async exportMyAssignedOrders(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const myUserId = me?.id;
        if (!myUserId) throw new BadRequestException("Missing user ID");

        // 1. نفس منطق بناء الاستعلام (Query Builder)
        const search = String(q?.search ?? "").trim();
        const qb = this.orderRepo
            .createQueryBuilder("order")
            .where("order.adminId = :adminId", { adminId })
            .innerJoinAndSelect(
                "order.assignments",
                "assignment",
                "assignment.isAssignmentActive = true AND assignment.employeeId = :myUserId",
                { myUserId },
            )
            .leftJoinAndSelect("order.items", "items")
            .leftJoinAndSelect("items.variant", "variant")
            .leftJoinAndSelect("variant.product", "product")
            .leftJoinAndSelect("order.status", "status")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoinAndSelect("order.store", "store")
            .leftJoinAndSelect("assignment.employee", "employee");

        // 2. تطبيق نفس الفلاتر
        if (q?.status) {
            const statusParam = q.status;
            if (!isNaN(Number(statusParam))) {
                qb.andWhere("order.statusId = :statusId", { statusId: Number(statusParam) });
            } else {
                qb.andWhere("status.code = :statusCode", { statusCode: String(statusParam).trim() });
            }
        }
        if (q?.type) qb.andWhere("order.type = :type", { type: q.type });
        if (q?.paymentStatus) qb.andWhere("order.paymentStatus = :paymentStatus", { paymentStatus: q.paymentStatus });
        if (q?.paymentMethod) qb.andWhere("order.paymentMethod = :paymentMethod", { paymentMethod: q.paymentMethod });
        if (q?.shippingCompanyId) qb.andWhere("order.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: q.shippingCompanyId });
        if (q?.storeId) qb.andWhere("order.storeId = :storeId", { storeId: q.storeId });

        DateFilterUtil.applyToQueryBuilder(qb, "order.created_at", q?.startDate, q?.endDate);

        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
                        .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // 3. جلب جميع البيانات بدون Pagination للتصدير
        qb.orderBy("order.created_at", "DESC");
        const orders = await qb.getMany();

        // 4. تحضير البيانات (Prepare Data)
        const exportData = orders.map((order) => {
            return {
                orderNumber: order.orderNumber || "N/A",
                status: order.status?.name || order.status?.code || "N/A",
                customerName: order.customerName || "N/A",
                phoneNumber: order.phoneNumber || "N/A",
                city: order.city || "N/A",
                paymentStatus: order.paymentStatus || "N/A",
                shippingCompany: order.shippingCompany?.name || "N/A",
                store: order.store?.name || "N/A",
                finalTotal: order.finalTotal || 0,
                createdAt: order.created_at
                    ? new Date(order.created_at).toLocaleString("en-GB")
                    : "N/A",
            };
        });

        // 5. إنشاء ملف الإكسل (Create Workbook)
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("My Assigned Orders");

        const columns = [
            { header: "Order Number", key: "orderNumber", width: 20 },
            { header: "Status", key: "status", width: 15 },
            { header: "Customer Name", key: "customerName", width: 25 },
            { header: "Phone Number", key: "phoneNumber", width: 18 },
            { header: "City", key: "city", width: 18 },
            { header: "Final Total", key: "finalTotal", width: 15 },
            { header: "Payment Status", key: "paymentStatus", width: 18 },
            { header: "Shipping Company", key: "shippingCompany", width: 20 },
            { header: "Store", key: "store", width: 20 },
            { header: "Created At", key: "createdAt", width: 20 },
        ];

        worksheet.columns = columns;

        // تنسيق رأس الجدول (Style header row)
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        // إضافة البيانات (Add data rows)
        exportData.forEach((row) => {
            worksheet.addRow(row);
        });

        // 6. توليد الـ Buffer
        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    }



    async getNextAssignedOrder(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const order = await this.orderRepo
            .createQueryBuilder("order")
            .innerJoinAndSelect(
                "order.assignments",
                "assignment",
                `
        assignment.employeeId = :userId
        AND assignment.isAssignmentActive = true
        AND assignment.finishedAt IS NULL
        AND (
          assignment.lockedUntil IS NULL
          OR assignment.lockedUntil <= NOW()
        )
      `,
                { userId: me?.id },
            )
            .where("order.adminId = :adminId", { adminId })
            .leftJoinAndSelect("order.items", "items")
            .leftJoinAndSelect("items.variant", "variant")
            .leftJoinAndSelect("variant.product", "product")
            .leftJoinAndSelect("order.statusHistory", "statusHistory")
            .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
            .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
            .leftJoinAndSelect("order.status", "status")
            .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
            .leftJoinAndSelect("order.store", "store")
            .orderBy("assignment.assignedAt", "ASC") // 🔥 Old → New
            .addOrderBy("order.id", "ASC")
            .getOne();

        if (!order) return null;

        // Collect upselling product ids
        const upsellingIds = new Set<string>();

        for (const item of order.items || []) {
            if (!item.variant?.product?.upsellingEnabled) continue;
            for (const upsell of item.variant?.product?.upsellingProducts || []) {
                if (upsell.productId) {
                    upsellingIds.add(upsell.productId);
                }
            }
        }

        // Fetch lightweight products with SKUs to calculate stock
        const upsellingProducts = upsellingIds.size
            ? await this.productRepo
                .createQueryBuilder("product")
                .leftJoinAndSelect(
                    "product.variants",
                    "skus",
                    "skus.isActive = true",
                )
                .select([
                    "product.id",
                    "product.name",
                    "product.sku",
                    "product.type",
                    "product.mainImage",
                    "product.lowestPrice",
                    "product.salePrice",
                    "skus.id",
                    "skus.stockOnHand",
                    "skus.reserved",
                ])
                .where("product.id IN (:...ids)", {
                    ids: [...upsellingIds],
                })
                .getMany()
            : [];

        const productEntries = await Promise.all(
            upsellingProducts.map(async (p): Promise<[string, typeof p & { totalAvailable: number }]> => {
                const totals = (p.variants || []).reduce(
                    (acc, sku) => {
                        acc.totalStock += sku.stockOnHand || 0;
                        acc.totalReserved += sku.reserved || 0;
                        return acc;
                    },
                    { totalStock: 0, totalReserved: 0 },
                );

                const totalAvailable = await this.ordersService.calculateAvailableStock(
                    totals.totalStock,
                    totals.totalReserved,
                    adminId,
                );

                return [p.id, { ...p, totalAvailable }];
            }),
        );

        const productMap = new Map(productEntries);

        // Attach product info
        for (const item of order.items || []) {
            (item as any).upsellingProducts = item.variant?.product?.upsellingProducts || [];
            (item as any).upsellingProducts = ((item as any).upsellingProducts || []).map(
                (upsell) => ({
                    ...upsell,
                    product: productMap.get(upsell.productId) || null,
                }),
            );
        }

        return order;
    }

    async getFreeOrders(me: any, q: GetFreeOrdersDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const fetchLimit = Number(q.limit) || 20;

        const qb = this.orderRepo
            .createQueryBuilder("order")
            .innerJoin("order.status", "status")
            .where("order.adminId = :adminId", { adminId })
            .andWhere((qb) => {
                const subQuery = qb
                    .subQuery()
                    .select("1")
                    .from("order_assignments", "assignment")
                    .where("assignment.orderId = order.id")
                    .andWhere("assignment.isAssignmentActive = true")
                    .getQuery();
                return `NOT EXISTS ${subQuery}`;
            });

        // ✅ Multiple statuses filter
        if (q.statusIds?.length) {
            qb.andWhere("status.id IN (:...statusIds)", {
                statusIds: q.statusIds,
            });
        }
        DateFilterUtil.applyToQueryBuilder(qb, 'order.created_at', q?.startDate, q?.endDate);
        // Date filters

        // Cursor pagination
        if (q.cursor) {
            qb.andWhere("order.created_at < :cursor", { cursor: q.cursor });
        }

        qb.orderBy("order.created_at", "DESC").limit(fetchLimit + 1); // fetch one extra to check hasMore

        const orders = await qb.getMany();

        const hasMore = orders.length > fetchLimit;
        if (hasMore) orders.pop();

        const nextCursor =
            hasMore && orders.length > 0
                ? orders[orders.length - 1].created_at
                : null;

        return {
            data: orders,
            nextCursor,
            hasMore,
        };
    }

    /** Get count of free (unassigned) orders by status and optional date range. */
    async getFreeOrdersCount(
        me: any,
        q: { statusIds: string[]; startDate?: string; endDate?: string },
    ) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const qb = this.orderRepo
            .createQueryBuilder("order")
            .innerJoin("order.status", "status")
            .where("order.adminId = :adminId", { adminId })
            .andWhere((qb) => {
                const subQuery = qb
                    .subQuery()
                    .select("1")
                    .from("order_assignments", "assignment")
                    .where("assignment.orderId = order.id")
                    .andWhere("assignment.isAssignmentActive = true")
                    .getQuery();
                return `NOT EXISTS ${subQuery}`;
            });

        if (q.statusIds?.length) {
            qb.andWhere("status.id IN (:...statusIds)", {
                statusIds: q.statusIds,
            });
        }
        DateFilterUtil.applyToQueryBuilder(qb, 'order.created_at', q?.startDate, q?.endDate);

        const count = await qb.getCount();
        return { count };
    }

    // =========================================================================
    // AUTO ASSIGN RULES MANAGEMENT
    // =========================================================================

    async listAutoAssignRules(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        const qb = this.autoAssignRuleRepo
            .createQueryBuilder("rule")
            .where("rule.adminId = :adminId", { adminId })
            .leftJoinAndSelect("rule.products", "products")
            .leftJoinAndSelect("rule.cities", "cities")
            .leftJoinAndSelect("rule.employees", "employees")
            .leftJoinAndSelect("rule.stores", "stores");

        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where("rule.name ILIKE :s", { s: `%${search}%` });
            }));
        }
        DateFilterUtil.applyToQueryBuilder(qb, "rule.createdAt", q?.startDate, q?.endDate);

        if (q?.ruleType) {
            qb.andWhere("rule.ruleType = :ruleType", { ruleType: q.ruleType });
        }

        if (q?.strategy) {
            qb.andWhere("rule.strategy = :strategy", { strategy: q.strategy });
        }

        if (q?.isActive !== undefined && q?.isActive !== "") {
            qb.andWhere("rule.isActive = :isActive", { isActive: q.isActive === 'true' });
        }

        qb.orderBy("rule.priority", "ASC")
            .addOrderBy("rule.id", "ASC");

        const total = await qb.getCount();
        const records = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getMany();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
        };
    }

    async createAutoAssignRule(me: any, dto: CreateAutoAssignRuleDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const existingRule = await this.autoAssignRuleRepo.findOne({ where: { name: dto.name, adminId } });
        if (existingRule) throw new BadRequestException("Rule name already exists");

        const rule = this.autoAssignRuleRepo.create({
            ...dto,
            adminId,
        });

        const promises: Promise<any>[] = [];

        if (dto.productIds?.length) {
            promises.push(this.productRepo.find({ where: { id: In(dto.productIds), isActive: true } }).then(products => {
                if (products.length !== dto.productIds.length) throw new BadRequestException("Some Products not found");
                rule.products = products;
            }));
        }
        if (dto.cityIds?.length) {
            promises.push(this.cityRepo.find({ where: { id: In(dto.cityIds), isActive: true } }).then(cities => {
                if (cities.length !== dto.cityIds.length) throw new BadRequestException("Some Cities not found");
                rule.cities = cities;
            }));
        }

        if (dto.storeIds?.length) {
            promises.push(this.storeRepo.find({ where: { id: In(dto.storeIds), isActive: true } }).then(stores => {
                if (stores.length !== dto.storeIds.length) throw new BadRequestException("Some Stores not found");
                rule.stores = stores;
            }));
        }

        if (dto.employeeIds?.length) {
            promises.push(this.userRepo.find({ where: { id: In(dto.employeeIds), adminId, isActive: true } }).then(employees => {
                if (employees.length !== dto.employeeIds.length) throw new BadRequestException("Some Employees not found");
                rule.employees = employees;
            }));
        }

        if (promises.length) await Promise.all(promises);

        return this.autoAssignRuleRepo.save(rule);
    }

    async updateAutoAssignRule(me: any, id: string, dto: UpdateAutoAssignRuleDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const rule = await this.autoAssignRuleRepo.findOne({ where: { id, adminId } });
        if (!rule) throw new NotFoundException("Rule not found");

        if (dto.name && dto.name !== rule.name) {
            const existingRule = await this.autoAssignRuleRepo.findOne({ where: { name: dto.name, adminId } });
            if (existingRule) throw new BadRequestException("Rule name already exists");
        }

        Object.assign(rule, dto);

        const promises: Promise<any>[] = [];

        if (dto.productIds !== undefined) {
            promises.push((dto.productIds.length ? this.productRepo.find({ where: { id: In(dto.productIds), isActive: true } }) : Promise.resolve([])).then(products => {
                if (dto.productIds.length && products.length !== dto.productIds.length) throw new BadRequestException("Some Products not found");
                rule.products = products;
            }));
        }
        if (dto.cityIds !== undefined) {
            promises.push((dto.cityIds.length ? this.cityRepo.find({ where: { id: In(dto.cityIds), isActive: true } }) : Promise.resolve([])).then(cities => {
                if (dto.cityIds.length && cities.length !== dto.cityIds.length) throw new BadRequestException("Some Cities not found");
                rule.cities = cities;
            }));
        }

        if (dto.storeIds !== undefined) {
            promises.push((dto.storeIds.length ? this.storeRepo.find({ where: { id: In(dto.storeIds), isActive: true } }) : Promise.resolve([])).then(stores => {
                if (dto.storeIds.length && stores.length !== dto.storeIds.length) throw new BadRequestException("Some Stores not found");
                rule.stores = stores;
            }));
        }

        if (dto.employeeIds !== undefined) {
            promises.push((dto.employeeIds.length ? this.userRepo.find({ where: { id: In(dto.employeeIds), adminId, isActive: true } }) : Promise.resolve([])).then(employees => {
                if (dto.employeeIds.length && employees.length !== dto.employeeIds.length) throw new BadRequestException("Some Employees not found");
                rule.employees = employees;
            }));
        }

        if (promises.length) await Promise.all(promises);

        return this.autoAssignRuleRepo.save(rule);
    }

    async getAutoAssignRuleDetails(me: any, id: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const rule = await this.autoAssignRuleRepo.findOne({
            where: { id, adminId },
            relations: ["products", "cities", "employees"],
        });

        if (!rule) throw new NotFoundException("Rule not found");
        return rule;
    }

    async toggleAutoAssignRuleActive(me: any, id: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const rule = await this.autoAssignRuleRepo.findOne({ where: { id, adminId } });
        if (!rule) throw new NotFoundException("Rule not found");

        rule.isActive = !rule.isActive;
        return this.autoAssignRuleRepo.save(rule);
    }

    async deleteAutoAssignRule(me: any, id: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const rule = await this.autoAssignRuleRepo.findOne({ where: { id, adminId } });
        if (!rule) throw new NotFoundException("Rule not found");

        await this.autoAssignRuleRepo.remove(rule);
        return { success: true };
    }

    async getAutoAssignRulesStats(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const [generalStats, typeStats] = await Promise.all([
            this.autoAssignRuleRepo
                .createQueryBuilder("rule")
                .select("COUNT(rule.id)", "total")
                .addSelect("SUM(CASE WHEN rule.isActive = true THEN 1 ELSE 0 END)", "active")
                .where("rule.adminId = :adminId", { adminId })
                .getRawOne(),
            this.autoAssignRuleRepo
                .createQueryBuilder("rule")
                .select("rule.ruleType", "type")
                .addSelect("COUNT(rule.id)", "count")
                .where("rule.adminId = :adminId", { adminId })
                .groupBy("rule.ruleType")
                .getRawMany(),
        ]);

        const byType: Record<string, number> = {};
        typeStats.forEach(ts => {
            byType[ts.type] = parseInt(ts.count, 10);
        });

        return {
            total: parseInt(generalStats.total || 0, 10),
            active: parseInt(generalStats.active || 0, 10),
            byType,
        };
    }

    async exportAutoAssignRules(me: any, q?: any) {
        const { records } = await this.listAutoAssignRules(me, { ...q, limit: 10000 });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Auto Assign Rules");

        worksheet.columns = [
            { header: "Name", key: "name", width: 25 },
            { header: "Type", key: "ruleType", width: 20 },
            { header: "Status", key: "status", width: 15 },
            { header: "Priority", key: "priority", width: 10 },
            { header: "Description", key: "description", width: 30 },
            { header: "Strategy", key: "strategy", width: 15 },
            { header: "Min Amount", key: "minAmount", width: 15 },
            { header: "Max Amount", key: "maxAmount", width: 15 },
            { header: "Payment Status", key: "paymentStatus", width: 15 },
            { header: "Target Employees", key: "employees", width: 30 },
            { header: "Products", key: "products", width: 30 },
            { header: "Cities", key: "cities", width: 30 },
            { header: "Stores", key: "stores", width: 30 },
        ];

        const rows = records.map(rule => ({
            name: rule.name,
            ruleType: rule.ruleType,
            status: rule.isActive ? "Active" : "Inactive",
            paymentStatus: rule.paymentStatus,
            minAmount: rule.minAmount,
            maxAmount: rule.maxAmount,
            strategy: rule.strategy,
            priority: rule.priority,
            description: rule.description || "—",
            employees: rule.employees?.map(e => e.name).join(", ") || "—",
            products: rule.products?.map(e => e.name).join(", ") || "—",
            cities: rule.cities?.map(e => e.nameEn).join(", ") || "—",
            stores: rule.stores?.map(e => e.name).join(", ") || "—",
        }));

        worksheet.addRows(rows);

        // Styling
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F46E5' },
        };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

        return await workbook.xlsx.writeBuffer();
    }

    async processAutoAssignment(adminId: any, orderIds: string[]) {

        if (!adminId) throw new BadRequestException("Missing adminId");

        // 1. Get active rules ordered by priority
        const rules = await this.autoAssignRuleRepo.find({
            where: { adminId, isActive: true },
            relations: ["products", "cities", "employees", "stores"],
            order: { priority: "ASC", createdAt: "ASC" },
        });

        if (!rules.length) return { message: "No active rules found", noActiveRules: true, assignedCount: 0 };

        // 2. Fetch orders with necessary details
        const orders = await this.orderRepo.find({
            where: { id: In(orderIds), adminId },
            relations: ["items", "items.variant", "items.variant.product", "cityDetails", "status"],
        });

        const settings = await this.ordersService.getCachedSettings(adminId);
        if (settings && settings.assignmentMode === AssignmentMode.DISABLED) {
            return { message: "Auto-assignment is disabled", assignedCount: 0 };
        }
        const maxRetries = settings?.maxRetries || 3;

        let assignedCount = 0;
        const results = [];

        for (const order of orders) {
            // Check if already assigned
            const existingAssignment = await this.orderAssignmentRepo.findOne({
                where: { orderId: order.id, isAssignmentActive: true }
            });
            if (existingAssignment) continue;

            // Check if status allowed
            if (order.status && !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(order.status.code as OrderStatus)) {
                continue;
            }

            // Find matching rule
            const rule = this.findMatchingRule(order, rules);
            if (rule && rule.employees?.length) {
                const employee = await this.selectEmployeeByStrategy(rule);
                if (employee) {
                    await this.orderAssignmentRepo.save(this.orderAssignmentRepo.create({
                        orderId: order.id,
                        employeeId: employee.id,
                        assignedByAdminId: adminId,
                        maxRetriesAtAssignment: maxRetries,
                        isAssignmentActive: true,
                    }));
                    assignedCount++;
                    //send notification to admin about thi assignment

                    await this.notificationService.create({
                        userId: adminId,
                        type: NotificationType.ORDER_ASSIGNED,
                        title: "Order Assigned",
                        message: `Order #${order.orderNumber} has been assigned to employee ${employee.name} with rule ${rule.name}.`,
                        relatedEntityType: "order",
                        relatedEntityId: String(order.id),
                    });

                    results.push({ orderId: order.id, orderNumber: order.orderNumber, employeeId: employee.id, ruleName: rule.name });
                }
            }
        }

        return { success: true, assignedCount, results };
    }

    private findMatchingRule(order: OrderEntity, rules: AutoAssignRuleEntity[]): AutoAssignRuleEntity | null {
        for (const rule of rules) {
            if (this.isRuleMatch(order, rule)) {
                return rule;
            }
        }
        return null;
    }

    private isRuleMatch(order: OrderEntity, rule: AutoAssignRuleEntity): boolean {
        const now = new Date();

        // =========================
        // 1. DATE RANGE CHECK
        // =========================
        if (rule.activeFrom && now < new Date(rule.activeFrom)) return false;
        if (rule.activeUntil && now > new Date(rule.activeUntil)) return false;
        // =========================
        // 2. WEEKDAY CHECK (BITMASK)
        // =========================
        if (rule.weekDays != null) {

            const currentWeekDay = WeekDayHelper.WEEKDAY_BITS[now.getDay() % 7];

            if (!BitmaskHelper.has(rule.weekDays, currentWeekDay)) {
                return false;
            }
        }

        // =========================
        // 3. TIME WINDOW CHECK
        // =========================
        if (rule.startTime || rule.endTime) {
            const timezone = rule.timezone || "Africa/Cairo";
            const now = new Date();

            // Get current hours and minutes in the rule's timezone
            const formatter = new Intl.DateTimeFormat("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: timezone,
            });
            const parts = formatter.formatToParts(now);
            const currentHours = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
            const currentMinutes = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
            const currentTotalMinutes = currentHours * 60 + currentMinutes;

            // Convert start time to total minutes if set
            if (rule.startTime) {
                const [startHours, startMins] = rule.startTime.split(":").map(Number);
                const startTotalMinutes = startHours * 60 + startMins;
                if (currentTotalMinutes < startTotalMinutes) {
                    return false;
                }
            }

            // Convert end time to total minutes if set
            if (rule.endTime) {
                const [endHours, endMins] = rule.endTime.split(":").map(Number);
                const endTotalMinutes = endHours * 60 + endMins;
                if (currentTotalMinutes > endTotalMinutes) {
                    return false;
                }
            }
        }

        switch (rule.ruleType) {
            case AutoAssignRuleType.MANUAL:
                return true;
            case AutoAssignRuleType.PRODUCT:
                if (!rule.products?.length) return false;
                const orderProductIds = order.items?.map(item => item.variant?.productId).filter(Boolean) || [];
                const ruleProductIds = rule.products.map(p => p.id);
                return orderProductIds.some(pid => ruleProductIds.includes(pid));
            case AutoAssignRuleType.CITY:
                if (!rule.cities?.length) return false;
                const ruleCityIds = rule.cities.map(c => c.id);
                return ruleCityIds.includes(order.cityId);
            case AutoAssignRuleType.AMOUNT_RANGE:
                const total = Number(order.finalTotal || 0);
                const min = rule.minAmount !== null && rule.minAmount !== undefined ? Number(rule.minAmount) : -Infinity;
                const max = rule.maxAmount !== null && rule.maxAmount !== undefined ? Number(rule.maxAmount) : Infinity;
                return total >= min && total <= max;
            case AutoAssignRuleType.PAYMENT_STATUS:
                return order.paymentStatus === rule.paymentStatus;
            case AutoAssignRuleType.STORE:
                if (!rule.stores?.length) return false;
                const ruleStoreIds = rule.stores.map(s => s.id);
                return ruleStoreIds.includes(order.storeId);
            default:
                return false;
        }
    }

    private async selectEmployeeByStrategy(rule: AutoAssignRuleEntity): Promise<User | null> {
        const employees = rule.employees;
        if (!employees?.length) return null;

        if (rule.strategy === AssignmentStrategy.ROUND_ROBIN) {
            const sortedEmployees = [...employees].sort((a, b) => a.id.localeCompare(b.id));
            let nextIndex = 0;
            if (rule.lastAssignedEmployeeId) {
                const lastIndex = sortedEmployees.findIndex(e => e.id === rule.lastAssignedEmployeeId);
                if (lastIndex !== -1) {
                    nextIndex = (lastIndex + 1) % sortedEmployees.length;
                }
            }
            const selectedEmployee = sortedEmployees[nextIndex];

            // Update lastAssignedEmployeeId in DB
            await this.autoAssignRuleRepo.update(rule.id, { lastAssignedEmployeeId: selectedEmployee.id });

            return selectedEmployee;
        } else if (rule.strategy === AssignmentStrategy.LEAST_ACTIVE_ORDERS) {
            const employeeIds = employees.map(e => e.id);
            const counts = await this.orderAssignmentRepo
                .createQueryBuilder("oa")
                .select("oa.employeeId", "id")
                .addSelect("COUNT(oa.id)", "count")
                .where("oa.employeeId IN (:...employeeIds)", { employeeIds })
                .andWhere("oa.isAssignmentActive = true")
                .groupBy("oa.employeeId")
                .getRawMany();

            const countMap = new Map(counts.map(c => [c.id, parseInt(c.count, 10)]));

            let minCount = Infinity;
            let selectedEmployee = employees[0];

            for (const employee of employees) {
                const count = countMap.get(employee.id) || 0;
                if (count < minCount) {
                    minCount = count;
                    selectedEmployee = employee;
                }
            }
            return selectedEmployee;
        }
        return null;
    }

    
}
