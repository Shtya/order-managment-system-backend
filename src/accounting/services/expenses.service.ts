import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateManualExpenseDto, UpdateManualExpenseDto } from 'dto/accounting.dto';
import { ManualExpenseCategoryEntity, ManualExpenseEntity } from 'entities/accounting.entity';
import { tenantId } from 'src/category/category.service';
import { Brackets, DataSource, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { deleteFile } from 'common/healpers';
import { DateFilterUtil } from 'common/date-filter.util';
import { Account, AccountStatus, TransactionReferenceType } from 'entities/safe.entity';
import { SafesService } from 'src/safes/safes.service';
import { RequestTranslationService, TranslationService } from 'common/translation.service';

@Injectable()
export class ExpensesService {
    constructor(
        private dataSource: DataSource,

        @InjectRepository(ManualExpenseEntity)
        private expenseRepo: Repository<ManualExpenseEntity>,

        @InjectRepository(Account)
        private accountRepo: Repository<Account>,

        @InjectRepository(ManualExpenseCategoryEntity)
        private categoryRepo: Repository<ManualExpenseCategoryEntity>,

        private safesService: SafesService,
        private translations: TranslationService,
        private requestTranslationsService: RequestTranslationService,
    ) { }

    async listExpenses(me: any, q?: any) {
        const adminId = tenantId(me);
        const page = q?.page ?? 1;
        const limit = q?.limit ?? 10;

        const qb = this.expenseRepo
            .createQueryBuilder("expense")
            .leftJoinAndSelect("expense.category", "category")
            .leftJoinAndSelect("expense.user", "user")
            .leftJoinAndSelect("expense.safe", "safe")
            .where("expense.adminId = :adminId", { adminId });

        // فلاتر
        if (q?.categoryId && q?.categoryId !== "none") {
            qb.andWhere("expense.categoryId = :categoryId", { categoryId: q.categoryId });
        }

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("expense.description ILIKE :s", { s: searchTerm })
                        .orWhere("category.name ILIKE :s", { s: searchTerm })
                        .orWhere("safe.name ILIKE :s", { s: searchTerm });
                }),
            );
        }
        DateFilterUtil.applyToQueryBuilder(qb, "expense.collectionDate", q?.startDate, q?.endDate);

        const allowedSortFields = ['amount', 'collectionDate', 'createdAt'];
        const sortBy = allowedSortFields.includes(q?.sortBy) ? q.sortBy : 'collectionDate';

        const sortOrder = q?.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // 3. الترتيب والتنفيذ بشكل آمن
        qb.orderBy(`expense.collectionDate`, sortOrder)
            .addOrderBy(`expense.createdAt`, "DESC")
            .skip((page - 1) * limit)
            .take(limit);

        const [records, total] = await qb.getManyAndCount();

        return {
            records,
            total_records: total,
            current_page: page,
            per_page: limit,
        };
    }


    async getExpense(me: any, id: string) {
        const expense = await this.expenseRepo.findOne({
            where: {
                id,
                adminId: tenantId(me),
            },
            relations: ["category", "user", "safe"],
        });
        if (!expense) throw new NotFoundException(this.translations.t('domains.expenses.expense_not_found'));
        return expense;
    }
    async exportExpenses(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const qb = this.expenseRepo
            .createQueryBuilder("expense")
            .leftJoinAndSelect("expense.category", "category")
            .leftJoinAndSelect("expense.safe", "safe")
            .where("expense.adminId = :adminId", { adminId });

        // Apply same filters as listExpenses
        if (q?.categoryId && q?.categoryId !== "none") {
            qb.andWhere("expense.categoryId = :categoryId", { categoryId: q.categoryId });
        }

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("expense.description ILIKE :s", { s: searchTerm })
                        .orWhere("category.name ILIKE :s", { s: searchTerm })
                        .orWhere("safe.name ILIKE :s", { s: searchTerm });
                }),
            );
        }
        DateFilterUtil.applyToQueryBuilder(qb, "expense.collectionDate", q?.startDate, q?.endDate);


        qb.orderBy("expense.collectionDate", "DESC");

        const records = await qb.getMany();

        // Prepare Excel data
        const exportData = records.map((expense) => ({
            id: expense.id,
            category: expense.category?.name || "N/A",
            amount: Number(expense.amount),
            description: expense.description || "N/A",
            safe: expense.safe?.name || "N/A",
            collectionDate: expense.collectionDate ? new Date(expense.collectionDate).toLocaleDateString() : "N/A",
            createdAt: expense.createdAt ? new Date(expense.createdAt).toLocaleDateString() : "N/A",
            status: expense.monthlyClosingId ? "Closed" : "Pending"
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(this.translations.t('domains.expenses.excel_worksheet_title'));

        worksheet.columns = [
            { header: this.translations.t('common.id'), key: "id", width: 10 },
            { header: this.translations.t('domains.expenses.excel_header_category'), key: "category", width: 20 },
            { header: this.translations.t('common.amount'), key: "amount", width: 15 },
            { header: this.translations.t('common.description'), key: "description", width: 40 },
            { header: this.translations.t('domains.expenses.excel_header_safe'), key: "safe", width: 20 },
            { header: this.translations.t('domains.expenses.excel_header_collection_date'), key: "collectionDate", width: 20 },
            { header: this.translations.t('common.status'), key: "status", width: 15 },
            { header: this.translations.t('domains.expenses.excel_header_created_at'), key: "createdAt", width: 20 },
        ];

        // Style header row
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        exportData.forEach((row) => {
            worksheet.addRow(row);
        });

        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    }

    async createExpense(me: any, dto: CreateManualExpenseDto) {
        const adminId = tenantId(me);

        return this.dataSource.transaction(async (manager) => {
            const category = await manager.findOne(ManualExpenseCategoryEntity, {
                where: { id: dto.categoryId, adminId }
            });

            if (!category) {
                throw new NotFoundException(
                    this.translations.t('domains.expenses.category_not_found_with_id', { args: { categoryId: dto.categoryId } })
                );
            }

            if (dto.safeId) {
                const safe = await manager.findOne(Account, { where: { id: dto.safeId, adminId } as any });
                if (!safe) throw new BadRequestException(this.translations.t('domains.expenses.safe_account_not_found'));
                if (safe.status !== AccountStatus.ACTIVE) throw new BadRequestException(this.translations.t('domains.expenses.safe_account_not_active'));
            }

            const expense = manager.create(ManualExpenseEntity, {
                ...dto,
                adminId,
                createdByUserId: me.id,
            });

            const savedExpense = await manager.save(expense);

            if (Number(savedExpense.amount) > 0 && savedExpense.safeId) {
                const categoryName = category?.name || "N/A";
                await this.safesService.withdraw(me, {
                    accountId: savedExpense.safeId,
                    amount: Number(savedExpense.amount),
                    referenceType: TransactionReferenceType.OPERATING_EXPENSE,
                    referenceMeta: {
                        category: categoryName,
                    },
                    referenceId: savedExpense.id,
                    notes: await this.requestTranslationsService.tAsync('domains.expenses.log_expense_accepted', adminId,{ args: { amount: savedExpense.amount, categoryName } }),
                }, manager);
            }

            return savedExpense;
        });
    }

    async updateExpense(me: any, id: string, dto: UpdateManualExpenseDto) {
        const adminId = tenantId(me);

        return this.dataSource.transaction(async (manager) => {
            const expense = await manager.findOne(ManualExpenseEntity, {
                where: { id, adminId },
                relations: ['category']
            });

            if (!expense) {
                throw new NotFoundException(this.translations.t('domains.expenses.expense_record_not_found'));
            }

            if (expense.monthlyClosingId) {
                throw new BadRequestException(this.translations.t('domains.expenses.cannot_update_closed'));
            }

            const oldAmount = Number(expense.amount || 0);
            const oldSafeId = expense.safeId;

            if (dto.categoryId) {
                const category = await manager.findOne(ManualExpenseCategoryEntity, {
                    where: { id: dto.categoryId, adminId }
                });

                if (!category) {
                    throw new NotFoundException(
                        this.translations.t('domains.expenses.category_not_found_with_id', { args: { categoryId: dto.categoryId } })
                    );
                }
            }

            if (dto.safeId) {
                const safe = await manager.findOne(Account, { where: { id: dto.safeId, adminId } as any });
                if (!safe) throw new BadRequestException(this.translations.t('domains.expenses.safe_account_not_found'));
                if (safe.status !== AccountStatus.ACTIVE) throw new BadRequestException(this.translations.t('domains.expenses.safe_account_not_active'));
            }

            // Reverse old safe transaction if it existed
            if (oldAmount > 0 && oldSafeId) {
                const categoryName = expense.category?.name || "N/A";
                await this.safesService.deposit(me, {
                    accountId: oldSafeId,
                    amount: oldAmount,
                    referenceType: TransactionReferenceType.EXPENSE_REFUND,
                    referenceId: expense.id,
                    referenceMeta: {
                        category: categoryName,
                    },
                    notes: await this.requestTranslationsService.tAsync('domains.expenses.log_reversing_old_expense', adminId, { args: { oldAmount } }),
                }, manager);
            }

            if (dto.attachment && expense.attachment && dto.attachment !== expense.attachment) {
                await deleteFile(expense.attachment);
            }

            Object.assign(expense, dto);
            const savedExpense = await manager.save(expense);

            // Apply new safe transaction
            if (Number(savedExpense.amount) > 0 && savedExpense.safeId) {
                const category = await manager.findOne(ManualExpenseCategoryEntity, {
                    where: { id: savedExpense.categoryId, adminId },
                });
                const categoryName = category?.name || "N/A";
                await this.safesService.withdraw(me, {
                    accountId: savedExpense.safeId,
                    amount: Number(savedExpense.amount),
                    referenceType: TransactionReferenceType.OPERATING_EXPENSE,
                    referenceId: savedExpense.id,
                    referenceMeta: {
                        category: categoryName,
                    },
                    notes: await this.requestTranslationsService.tAsync('domains.expenses.log_expense_updated', adminId,{ args: { amount: savedExpense.amount, categoryName } }),
                }, manager);
            }

            return savedExpense;
        });
    }

    async deleteExpense(me: any, id: string) {
        const adminId = tenantId(me);

        return this.dataSource.transaction(async (manager) => {
            const expense = await manager.findOne(ManualExpenseEntity, {
                where: { id, adminId },
                relations: ['category']
            });

            if (!expense) {
                throw new NotFoundException(this.translations.t('domains.expenses.expense_record_not_found'));
            }

            if (expense.monthlyClosingId) {
                throw new BadRequestException(this.translations.t('domains.expenses.cannot_delete_closed'));
            }

            const amount = Number(expense.amount || 0);
            const safeId = expense.safeId;

            // Reverse safe transaction (Deposit back)
            if (amount > 0 && safeId) {
                const categoryName = expense.category?.name || "N/A";
                await this.safesService.deposit(me, {
                    accountId: safeId,
                    amount: amount,
                    referenceType: TransactionReferenceType.EXPENSE_REFUND,
                    referenceId: expense.id,
                    referenceMeta: {
                        category: categoryName,
                    },
                    notes: await this.requestTranslationsService.tAsync('domains.expenses.log_expense_deleted_refunding', adminId, { args: { amount } }),
                }, manager);
            }

            if (expense.attachment) {
                await deleteFile(expense.attachment);
            }

            await manager.remove(expense);

            return {
                success: true,
                message: this.translations.t('domains.expenses.expense_deleted_successfully')
            };
        });
    }
}
