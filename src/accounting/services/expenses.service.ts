import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateManualExpenseDto, UpdateManualExpenseDto } from 'dto/accounting.dto';
import { ManualExpenseCategoryEntity, ManualExpenseEntity } from 'entities/accounting.entity';
import { tenantId } from 'src/category/category.service';
import { Brackets, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { deleteFile } from 'common/healpers';
import { DateFilterUtil } from 'common/date-filter.util';

@Injectable()
export class ExpensesService {
    constructor(
        @InjectRepository(ManualExpenseEntity)
        private expenseRepo: Repository<ManualExpenseEntity>,

        @InjectRepository(ManualExpenseCategoryEntity)
        private categoryRepo: Repository<ManualExpenseCategoryEntity>,
    ) { }

    async listExpenses(me: any, q?: any) {
        const adminId = tenantId(me);
        const page = q?.page ?? 1;
        const limit = q?.limit ?? 10;

        const qb = this.expenseRepo
            .createQueryBuilder("expense")
            .leftJoinAndSelect("expense.category", "category")
            .leftJoinAndSelect("expense.user", "user")
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
                        .orWhere("category.name ILIKE :s", { s: searchTerm });
                }),
            );
        }
        DateFilterUtil.applyToQueryBuilder(qb, "expense.collectionDate", q?.startDate, q?.endDate);

        const allowedSortFields = ['amount', 'collectionDate', 'createdAt'];
        const sortBy = allowedSortFields.includes(q?.sortBy) ? q.sortBy : 'collectionDate';

        const sortOrder = q?.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // 3. الترتيب والتنفيذ بشكل آمن
        qb.orderBy(`expense.${sortBy}`, sortOrder)
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

    async exportExpenses(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const qb = this.expenseRepo
            .createQueryBuilder("expense")
            .leftJoinAndSelect("expense.category", "category")
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
                        .orWhere("category.name ILIKE :s", { s: searchTerm });
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
            collectionDate: expense.collectionDate ? new Date(expense.collectionDate).toLocaleDateString() : "N/A",
            createdAt: expense.createdAt ? new Date(expense.createdAt).toLocaleDateString() : "N/A",
            status: expense.monthlyClosingId ? "Closed" : "Pending"
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Manual Expenses");

        worksheet.columns = [
            { header: "ID", key: "id", width: 10 },
            { header: "Category", key: "category", width: 20 },
            { header: "Amount", key: "amount", width: 15 },
            { header: "Description", key: "description", width: 40 },
            { header: "Collection Date", key: "collectionDate", width: 20 },
            { header: "Status", key: "status", width: 15 },
            { header: "Created At", key: "createdAt", width: 20 },
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
        const category = await this.categoryRepo.findOne({
            where: { id: dto.categoryId, adminId }
        });

        if (!category) {
            throw new NotFoundException(`Category with ID ${dto.categoryId} not found for this tenant`);
        }

        const expense = this.expenseRepo.create({
            ...dto,
            adminId,
            createdByUserId: me.id,
        });
        return await this.expenseRepo.save(expense);
    }

    async updateExpense(me: any, id: number, dto: UpdateManualExpenseDto) {
        const adminId = tenantId(me);

        const expense = await this.expenseRepo.findOne({
            where: { id, adminId }
        });

        if (!expense) {
            throw new NotFoundException('Expense record not found');
        }

        if (expense.monthlyClosingId) {
            throw new BadRequestException("Cannot update a expense that has been closed.");
        }

        if (dto.categoryId) {
            const category = await this.categoryRepo.findOne({
                where: { id: dto.categoryId, adminId }
            });

            if (!category) {
                throw new NotFoundException(`Category with ID ${dto.categoryId} not found for this tenant`);
            }
        }

        if (dto.attachment) {
            await deleteFile(expense.attachment);
            expense.attachment = dto.attachment;
        }
        Object.assign(expense, dto);

        return await this.expenseRepo.save(expense);
    }

    async deleteExpense(me: any, id: number) {
        const adminId = tenantId(me);

        const expense = await this.expenseRepo.findOne({
            where: { id, adminId }
        });

        if (!expense) {
            throw new NotFoundException('Expense record not found');
        }

        if (expense.monthlyClosingId) {
            throw new BadRequestException("Cannot delete a expense that has been closed.");
        }
        if (expense.attachment) {

            await deleteFile(expense.attachment);
        }
        await this.expenseRepo.remove(expense);

        return {
            success: true,
            message: 'Expense deleted successfully'
        };
    }
}
