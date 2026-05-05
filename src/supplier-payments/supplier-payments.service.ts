import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { SupplierPaymentEntity, SupplierPaymentAllocationEntity } from 'entities/supplier_payments.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { Account, TransactionReferenceType } from 'entities/safe.entity';
import { CreateSupplierPaymentDto, SupplierPaymentFilterDto } from 'dto/supplier_payments.dto';
import { SafesService } from '../safes/safes.service';
import { tenantId } from 'src/category/category.service';
import * as ExcelJS from 'exceljs';
import { ApprovalStatus } from 'common/enums';

@Injectable()
export class SupplierPaymentsService {
    constructor(
        @InjectRepository(SupplierPaymentEntity)
        private paymentRepo: Repository<SupplierPaymentEntity>,
        @InjectRepository(SupplierEntity)
        private supplierRepo: Repository<SupplierEntity>,
        @InjectRepository(PurchaseInvoiceEntity)
        private invoiceRepo: Repository<PurchaseInvoiceEntity>,
        @InjectRepository(Account)
        private accountRepo: Repository<Account>,
        private safesService: SafesService,
        private dataSource: DataSource,
    ) { }

    async create(me: any, dto: CreateSupplierPaymentDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException('Missing adminId');

        return await this.dataSource.transaction(async (manager) => {
            const supplier = await manager.findOne(SupplierEntity, { where: { id: dto.supplierId, adminId } });
            if (!supplier) throw new NotFoundException('Supplier not found');

            const safe = await manager.findOne(Account, { where: { id: dto.safeId, adminId } });
            if (!safe) throw new NotFoundException('Safe not found');

            let remainingToAllocate = dto.amount;
            const allocations: SupplierPaymentAllocationEntity[] = [];
            const invoicesToUpdate: PurchaseInvoiceEntity[] = [];

            // 1. Create the base payment entity first (to get ID for reference)
            const payment = manager.create(SupplierPaymentEntity, {
                adminId,
                supplierId: supplier.id,
                safeId: safe.id,
                amount: dto.amount,
                currency: safe.currency,
                paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : new Date(),
                notes: dto.notes,
                createdByUserId: me.id,
                supplierBalanceAfterPay: 0, // Will update below
                allocations: []
            });

            // We need to save it to get the ID for safesService.withdraw
            const savedPayment = await manager.save(payment);

            if (dto.invoiceId) {
                // Case A: Specific invoice
                const invoice = await manager.findOne(PurchaseInvoiceEntity, {
                    where: { id: dto.invoiceId, supplierId: dto.supplierId, adminId }
                });
                if (!invoice) throw new NotFoundException('Invoice not found for this supplier');

                const payable = Math.min(remainingToAllocate, Number(invoice.remainingAmount));
                if (payable <= 0) throw new BadRequestException('Invoice is already fully paid or amount is invalid');

                const alloc = this.prepareAllocation(manager, invoice, payable);
                allocations.push(alloc);
                invoicesToUpdate.push(invoice);
                remainingToAllocate -= payable;
            } else {
                // Case B: FIFO Payment - Optimized query
                const invoices = await manager.createQueryBuilder(PurchaseInvoiceEntity, 'inv')
                    .where('inv.supplierId = :supplierId', { supplierId: dto.supplierId })
                    .andWhere('inv.adminId = :adminId', { adminId })
                    .andWhere('inv.remainingAmount > 0')
                    .andWhere('inv.status = :accepted', { accepted: ApprovalStatus.ACCEPTED })
                    .andWhere('inv.closingId IS NOT NULL')
                    .orderBy('inv.created_at', 'ASC')
                    .getMany();

                for (const invoice of invoices) {
                    const rem = Number(invoice.remainingAmount);
                    const payable = Math.min(remainingToAllocate, rem);
                    if (payable <= 0) break;

                    const alloc = this.prepareAllocation(manager, invoice, payable);
                    allocations.push(alloc);
                    invoicesToUpdate.push(invoice);
                    remainingToAllocate -= payable;

                    if (remainingToAllocate <= 0) break;
                }
            }

            // Handle unallocated amount
            if (remainingToAllocate > 0) {
                const unallocated = manager.create(SupplierPaymentAllocationEntity, {
                    invoiceId: null,
                    amount: remainingToAllocate,
                    invoiceRemainingAfterPay: null
                });
                allocations.push(unallocated);
            }

            // 2. Update Supplier Balance
            supplier.dueBalance = Number(supplier.dueBalance) - dto.amount;
            await manager.save(supplier);

            // 3. Update Invoices
            if (invoicesToUpdate.length > 0) {
                await manager.save(invoicesToUpdate);
            }

            // 4. Update Payment with allocations and final balance
            savedPayment.allocations = allocations;
            savedPayment.supplierBalanceAfterPay = supplier.dueBalance;
            await manager.save(savedPayment);

            // 5. Log Financial Transaction (Withdraw from Safe)
            await this.safesService.withdraw(me, {
                accountId: safe.id,
                amount: dto.amount,
                referenceType: TransactionReferenceType.VENDOR_PAYMENT,
                referenceId: savedPayment.id,
                referenceMeta: {
                    supplierName: supplier.name,
                    invoicesCount: invoicesToUpdate.length,
                    ...(invoicesToUpdate.length === 1 ? { invoicesNumber: invoicesToUpdate[0].receiptNumber } : {}),
                    ...(remainingToAllocate > 0 ? { unallocatedAmount: remainingToAllocate } : {})
                },
                notes: dto.notes || `Payment to supplier ${supplier.name}`,
                transactionDate: savedPayment.paymentDate
            }, manager);

            return savedPayment;
        });
    }

    private prepareAllocation(manager: EntityManager, invoice: PurchaseInvoiceEntity, amount: number): SupplierPaymentAllocationEntity {
        invoice.paidAmount = Number(invoice.paidAmount) + amount;
        invoice.remainingAmount = Number(invoice.remainingAmount) - amount;

        return manager.create(SupplierPaymentAllocationEntity, {
            invoiceId: invoice.id,
            amount: amount,
            invoiceRemainingAfterPay: invoice.remainingAmount
        });
    }

    async getStats(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException('Missing adminId');

        const stats = await this.supplierRepo.createQueryBuilder('s')
            .select('COUNT(s.id)', 'totalSuppliers')
            .addSelect('SUM(CASE WHEN s.dueBalance > 0 THEN s.dueBalance ELSE 0 END)', 'totalShouldPay')
            .addSelect('SUM(CASE WHEN s.dueBalance < 0 THEN ABS(s.dueBalance) ELSE 0 END)', 'totalShouldCollect')
            .where('s.adminId = :adminId', { adminId })
            .getRawOne();

        return {
            totalSuppliers: Number(stats.totalSuppliers || 0),
            totalShouldPay: Number(stats.totalShouldPay || 0),
            totalShouldCollect: Number(stats.totalShouldCollect || 0),
        };
    }

    async findAll(me: any, q: SupplierPaymentFilterDto) {
        const adminId = tenantId(me);
        const page = Number(q.page || 1);
        const limit = Number(q.limit || 10);

        const qb = this.paymentRepo.createQueryBuilder('p')
            .leftJoinAndSelect('p.supplier', 's')
            .leftJoinAndSelect('p.safe', 'safe')
            .leftJoinAndSelect('p.createdByUser', 'u')
            .leftJoinAndSelect('p.allocations', 'alloc')
            .leftJoinAndSelect('alloc.invoice', 'inv')
            .where('p.adminId = :adminId', { adminId });

        if (q.supplierId) qb.andWhere('p.supplierId = :supplierId', { supplierId: q.supplierId });
        if (q.startDate) qb.andWhere('p.paymentDate >= :start', { start: q.startDate });
        if (q.endDate) qb.andWhere('p.paymentDate <= :end', { end: q.endDate });

        if (q.search) {
            qb.andWhere(`
        (
            s.name ILIKE :search
            OR EXISTS (
                SELECT 1
                FROM supplier_payment_allocation spa
                LEFT JOIN invoice i ON i.id = spa.invoiceId
                WHERE spa.paymentId = p.id
                AND i.receiptNumber ILIKE :search
            )
        )
    `, { search: `%${q.search}%` });
        }

        qb.orderBy('p.paymentDate', 'DESC')
            .addOrderBy('p.createdAt', 'DESC');

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
        };
    }

    async findOne(me: any, id: string) {
        const adminId = tenantId(me);
        const payment = await this.paymentRepo.findOne({
            where: { id, adminId },
            relations: ['supplier', 'safe', 'createdByUser', 'allocations', 'allocations.invoice']
        });

        if (!payment) throw new NotFoundException('Payment not found');
        return payment;
    }

    async export(me: any, q: SupplierPaymentFilterDto) {
        const { records } = await this.findAll(me, { ...q, limit: '10000' });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Supplier Payments');

        sheet.columns = [
            { header: 'Date', key: 'paymentDate', width: 20 },
            { header: 'Supplier', key: 'supplier', width: 25 },
            { header: 'Invoices', key: 'invoices', width: 30 },
            { header: 'Safe/Account', key: 'safe', width: 20 },
            { header: 'Total Amount', key: 'amount', width: 15 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Notes', key: 'notes', width: 35 },
            { header: 'Supplier Balance After', key: 'balanceAfter', width: 20 },
            { header: 'Created By', key: 'createdBy', width: 20 },
        ];

        records.forEach(p => {
            const invoiceDetails = p.allocations
                .map(a => a.invoice ? `#${a.invoice.receiptNumber} (${Number(a.amount).toLocaleString()})` : `Unallocated (${Number(a.amount).toLocaleString()})`)
                .join(', ');

            sheet.addRow({
                paymentDate: new Date(p.paymentDate).toLocaleString(),
                supplier: p.supplier?.name,
                invoices: invoiceDetails,
                safe: p.safe?.name,
                amount: Number(p.amount),
                currency: p.currency,
                notes: p.notes,
                balanceAfter: Number(p.supplierBalanceAfterPay),
                createdBy: p.createdByUser?.name,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }
}
