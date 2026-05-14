import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';


@Injectable()
export class WhatsappAccountService {
  constructor(
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
  ) { }

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const sortBy = String(q?.sortBy ?? "createdAt");


    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.accountRepo
      .createQueryBuilder("acc")

    qb.where("acc.adminId = :adminId", { adminId });

    // Mapping columns for sorting
    const sortColumns: Record<string, string> = {
      createdAt: "acc.createdAt",
      name: "acc.name",
      mobileNumber: "acc.mobileNumber",
    };

    // Filter by Active Status
    if (q?.isActive !== undefined && q.isActive !== 'all') {
      const activeStatus = q.isActive === 'true' || q.isActive === true;
      qb.andWhere("acc.isActive = :isActive", { isActive: activeStatus });
    }

    // Date range filter
    DateFilterUtil.applyToQueryBuilder(qb, "acc.createdAt", q?.startDate, q?.endDate);

    // Search logic
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("acc.name ILIKE :s", { s: `%${search}%` })
            .orWhere("acc.mobileNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("acc.wabaId ILIKE :s", { s: `%${search}%` })
            .orWhere("acc.phoneNumberId ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    // Sorting
    const orderBy = sortColumns[sortBy] || "acc.createdAt";
    qb.orderBy(orderBy, sortDir);

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

  async findOne(me: any, id: string) {
    const adminId = tenantId(me);
    const account = await this.accountRepo.findOne({ where: { id, adminId } });
    if (!account) throw new NotFoundException("WhatsApp account not found");
    return account;
  }

  async toggleActive(me: any, id: string) {
    const account = await this.findOne(me, id);
    account.isActive = !account.isActive;
    return await this.accountRepo.save(account);
  }

  async exportAccounts(me: any, q: any) {
    const adminId = tenantId(me);

    // إعادة استخدام منطق الـ QueryBuilder من الـ list بدون Pagination
    const { records } = await this.list(me, { ...q, limit: 5000, page: 1 });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("حسابات واتساب");

    worksheet.columns = [
      { header: "Name", key: "name", width: 25 },
      { header: "Mobile Number", key: "mobileNumber", width: 20 },
      { header: "WABA ID", key: "wabaId", width: 25 },
      { header: "Phone Number ID", key: "phoneNumberId", width: 25 },
      { header: "Status", key: "isActive", width: 12 },
      { header: "Created At", key: "createdAt", width: 20 },
    ];

    // Styling the header
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4F46E5" }, // Indigo shade
    };
    worksheet.getRow(1).alignment = { horizontal: "center" };

    records.forEach((acc) => {
      const row = worksheet.addRow({
        name: acc.name,
        mobileNumber: acc.mobileNumber,
        wabaId: acc.wabaId,
        phoneNumberId: acc.phoneNumberId,
        isActive: acc.isActive ? "Active" : "Inactive",
        createdAt: acc.createdAt ? new Date(acc.createdAt).toLocaleString() : "N/A",
      });
      row.alignment = { horizontal: "center" };
    });

    return await workbook.xlsx.writeBuffer();
  }

  async delete(me: any, id: string) {
    const account = await this.findOne(me, id);
    await this.accountRepo.delete(id);
    return account;
  }
}