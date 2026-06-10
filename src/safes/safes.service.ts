import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, Brackets } from 'typeorm';
import { Account, FinancialTransaction, AccountTransfer, AccountStatus, TransactionDirection, TransactionStatus, TransactionReferenceType } from 'entities/safe.entity';
import { CreateAccountDto, UpdateAccountDto, CreateTransactionDto, CreateTransferDto, AccountFilterDto, TransactionFilterDto, TransferFilterDto } from 'dto/safe.dto';
import { tenantId } from 'src/category/category.service';
import * as ExcelJS from 'exceljs';
import { formatReferenceMeta } from 'common/healpers';

@Injectable()
export class SafesService {
    constructor(
        @InjectRepository(Account)
        private accountRepo: Repository<Account>,
        @InjectRepository(FinancialTransaction)
        private transactionRepo: Repository<FinancialTransaction>,
        @InjectRepository(AccountTransfer)
        private transferRepo: Repository<AccountTransfer>,
        private dataSource: DataSource,
    ) { }


    // ─────────────────────────────────────────────────────────────────────────
    // ACCOUNTS MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    async listAccounts(me: any, q: AccountFilterDto) {
        const adminId = tenantId(me);
        const page = Number(q.page || 1);
        const limit = Number(q.limit || 10);
        const search = q.search?.trim();

        const qb = this.accountRepo.createQueryBuilder('a')
            .leftJoin('a.managedBy', 'e')
            .where('a.adminId = :adminId', { adminId })

        // Add subqueries for metrics
        qb.addSelect(subQuery => {
            return subQuery
                .select('COALESCE(SUM(t.amount), 0)', 'totalIn')
                .from(FinancialTransaction, 't')
                .where('t.accountId = a.id')
                .andWhere('t.direction = :inDir', { inDir: TransactionDirection.IN });
        }, 'totalIn');

        qb.addSelect(subQuery => {
            return subQuery
                .select('COALESCE(SUM(t.amount), 0)', 'totalOut')
                .from(FinancialTransaction, 't')
                .where('t.accountId = a.id')
                .andWhere('t.direction = :outDir', { outDir: TransactionDirection.OUT });
        }, 'totalOut');

        if (q.type) {
            qb.andWhere('a.type = :type', { type: q.type });
        }

        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where('a.name ILIKE :s', { s: `%${search}%` })
                    .orWhere('a.bankName ILIKE :s', { s: `%${search}%` })
                    .orWhere('a.accountNumber ILIKE :s', { s: `%${search}%` });
            }));
        }

        qb.orderBy('a.createdAt', 'DESC');

        const [rawRecords, total] = await Promise.all([
            qb.skip((page - 1) * limit).take(limit).getRawAndEntities(),
            qb.getCount()
        ]);

        const records = rawRecords.entities.map((entity, index) => {
            const raw = rawRecords.raw[index];
            return {
                ...entity,
                totalIn: Number(raw.totalIn || 0),
                totalOut: Number(raw.totalOut || 0),
            };
        });

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
        };
    }

    async getAccountById(me: any, id: string) {
        const adminId = tenantId(me);
        const account = await this.accountRepo.findOne({
            where: { id, adminId },
            relations: ['managedBy'],
        });

        if (!account) throw new NotFoundException('Account not found');
        return account;
    }


    async createAccount(me: any, dto: CreateAccountDto) {
        const adminId = tenantId(me);

        // We use the dataSource to start a database transaction
        return await this.dataSource.transaction(async (manager) => {

            const existing = await manager.findOne(Account, {
                where: {
                    name: dto.name,
                    adminId,
                },
            });

            if (existing) {
                throw new BadRequestException("Account name already exists");
            }

            // 1. Create the Account entity
            const account = manager.create(Account, {
                ...dto,
                adminId,
                // The current balance starts as the initial balance
                currentBalance: 0,
            });

            const savedAccount = await manager.save(account);

            if (dto.initialBalance > 0) {
                const financialDto: CreateTransactionDto = {
                    accountId: savedAccount.id,
                    amount: dto.initialBalance || 0,
                    referenceType: TransactionReferenceType.INITIAL_DEPOSIT,
                    notes: 'Initial Balance',
                }
                await this.createTransaction(me, { ...financialDto, direction: TransactionDirection.IN }, manager);
            }
            return savedAccount;
        });
    }

    async updateAccount(me: any, id: string, dto: UpdateAccountDto) {
        const adminId = tenantId(me);
        const account = await this.getAccountById(me, id);

        // Security check: managedById might be sensitive
        Object.assign(account, dto);
        return await this.accountRepo.save(account);
    }

    async toggleAccount(me: any, id: string) {
        const adminId = tenantId(me);
        const account = await this.getAccountById(me, id);

        account.status = account.status === AccountStatus.ACTIVE ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
        return await this.accountRepo.save(account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TRANSACTIONS (DEPOSIT / WITHDRAW)
    // ─────────────────────────────────────────────────────────────────────────

    async listTransactions(me: any, q: TransactionFilterDto) {
        const adminId = tenantId(me);
        const page = Number(q.page || 1);
        const limit = Number(q.limit || 10);
        const search = q.search?.trim();

        const qb = this.transactionRepo.createQueryBuilder('t')
            .innerJoinAndSelect('t.account', 'a')
            .leftJoinAndSelect('t.createdBy', 'u')
            .where('a.adminId = :adminId', { adminId });

        if (q.accountId) qb.andWhere('t.accountId = :accountId', { accountId: q.accountId });
        if (q.direction) qb.andWhere('t.direction = :direction', { direction: q.direction });
        if (q.referenceType) qb.andWhere('t.referenceType = :referenceType', { referenceType: q.referenceType });
        if (q.startDate) qb.andWhere('t.transactionDate >= :start', { start: q.startDate });
        if (q.endDate) qb.andWhere('t.transactionDate <= :end', { end: q.endDate });

        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where('t.number ILIKE :s', { s: `%${search}%` })
                    .orWhere('t.counterparty ILIKE :s', { s: `%${search}%` })
                    .orWhere('t.notes ILIKE :s', { s: `%${search}%` });
            }));
        }

        // qb.orderBy('t.transactionDate', 'DESC').addOrderBy('t.createdAt', 'DESC');
        qb.orderBy('t.createdAt', 'DESC');

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

    async getTransactionById(me: any, id: string) {
        const adminId = tenantId(me);
        const trx = await this.transactionRepo.findOne({
            where: { id, account: { adminId } },
            relations: ['account', 'createdBy'],
        });

        if (!trx) throw new NotFoundException('Transaction not found');
        return trx;
    }

    async deposit(me: any, dto: CreateTransactionDto, manager?: EntityManager) {
        return await this.createTransaction(me, { ...dto, direction: TransactionDirection.IN }, manager);
    }

    async withdraw(me: any, dto: CreateTransactionDto, manager?: EntityManager) {
        return await this.createTransaction(me, { ...dto, direction: TransactionDirection.OUT }, manager);
    }

    private async createTransaction(me: any, data: CreateTransactionDto & { direction: TransactionDirection, skipCommission?: boolean }, manager?: EntityManager) {
        const run = async (em: EntityManager) => {
            const adminId = tenantId(me);
            const account = await em.findOne(Account, { where: { id: data.accountId, adminId } });
            if (!account) throw new NotFoundException('Account not found');
            if (account.status === AccountStatus.SUSPENDED) throw new BadRequestException('Account is suspended');

            const amount = Number(data.amount);
            if (amount <= 0) throw new BadRequestException('Amount must be greater than 0');

            // Calculate Commission
            let commission = 0;
            if (data.direction === TransactionDirection.OUT && account.commissionRate > 0 && !data.skipCommission) {
                commission = Number((amount * (account.commissionRate / 100)).toFixed(2));
            }

            const totalDeduction = amount + commission;
            if (data.direction === TransactionDirection.OUT && Number(account.currentBalance) < totalDeduction) {
                throw new BadRequestException(
                    `Insufficient balance in "${account.name}": available ${account.currentBalance}, required ${totalDeduction} (incl. commission).`
                );
            }

            // Update Account Balance
            const balanceChange = data.direction === TransactionDirection.IN ? amount : -totalDeduction;
            const result = await em
                .createQueryBuilder()
                .update(Account)
                .set({
                    currentBalance: () =>
                        `currentBalance ${balanceChange >= 0 ? "+" : "-"} ${Math.abs(balanceChange)}`
                })
                .where("id = :id", { id: account.id })
                .returning(["currentBalance"])
                .execute();
                
            const newBalance = result.raw[0].currentBalance;

            const number = await this.generateTrxNumber(em);
            const trx = em.create(FinancialTransaction, {
                ...data,
                number: number,
                commission: commission,
                commissionRate: data.direction === TransactionDirection.OUT ? account.commissionRate : null,
                currency: account.currency,
                accountId: data.accountId,
                adminId,
                referenceMeta: data.referenceMeta || {},
                balanceAfter: Number(newBalance),
                transactionDate: data.transactionDate || new Date(),
                createdById: me.id,
                status: TransactionStatus.COMPLETED,
            });

            const savedTrx = await em.save(trx);



            return { ...savedTrx, commission };
        };

        if (manager) return await run(manager);
        return await this.dataSource.transaction(run);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TRANSFERS
    // ─────────────────────────────────────────────────────────────────────────

    async listTransfers(me: any, q: TransferFilterDto) {
        const adminId = tenantId(me);
        const page = Number(q.page || 1);
        const limit = Number(q.limit || 10);

        const qb = this.transferRepo.createQueryBuilder('tr')
            .innerJoinAndSelect('tr.fromAccount', 'fa')
            .leftJoinAndSelect('tr.outTransaction', 'outTrx')
            .innerJoinAndSelect('tr.toAccount', 'ta')
            .leftJoinAndSelect('tr.inTransaction', 'inTrx')
            .leftJoinAndSelect('tr.createdBy', 'u')
            .where('fa.adminId = :adminId', { adminId });

        if (q.fromAccountId) qb.andWhere('tr.fromAccountId = :fromId', { fromId: q.fromAccountId });
        if (q.toAccountId) qb.andWhere('tr.toAccountId = :toId', { toId: q.toAccountId });
        if (q.startDate) qb.andWhere('tr.createdAt >= :start', { start: q.startDate });
        if (q.endDate) qb.andWhere('tr.createdAt <= :end', { end: q.endDate });

        const search = q.search || '';
        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where('outTrx.number ILIKE :s', { s: `%${search}%` })
                    .orWhere('outTrx.counterparty ILIKE :s', { s: `%${search}%` })
                    .orWhere('outTrx.notes ILIKE :s', { s: `%${search}%` })
                    .orWhere('inTrx.counterparty ILIKE :s', { s: `%${search}%` })
                    .orWhere('inTrx.notes ILIKE :s', { s: `%${search}%` })
                    .orWhere('inTrx.number ILIKE :s', { s: `%${search}%` })
            }));
        }


        qb.orderBy('tr.createdAt', 'DESC');

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

    async transfer(me: any, dto: CreateTransferDto) {
        if (dto.fromAccountId === dto.toAccountId) throw new BadRequestException('Cannot transfer to the same account');

        return await this.dataSource.transaction(async (em) => {
            const adminId = tenantId(me);

            // Ensure both accounts exist and are active
            const [fromAccount, toAccount] = await Promise.all([
                em.findOne(Account, { where: { id: dto.fromAccountId, adminId } }),
                em.findOne(Account, { where: { id: dto.toAccountId, adminId } })
            ]);

            if (!fromAccount) throw new NotFoundException('Source account not found');
            if (!toAccount) throw new NotFoundException('Destination account not found');
            if (fromAccount.status !== AccountStatus.ACTIVE) throw new BadRequestException('Source account is suspended');
            if (toAccount.status !== AccountStatus.ACTIVE) throw new BadRequestException('Destination account is suspended');

            // 1. Withdraw from Source
            const outTrx = await this.createTransaction(me, {
                accountId: dto.fromAccountId,
                amount: Number(dto.amount),
                direction: TransactionDirection.OUT,
                referenceType: TransactionReferenceType.TRANSFER_OUT,
                notes: `Transfer to ${toAccount.name}. ${dto.notes || ''}`,
            }, em);

            // 2. Deposit to Destination
            const inTrx = await this.createTransaction(me, {
                accountId: dto.toAccountId,
                amount: dto.amount,
                direction: TransactionDirection.IN,
                referenceType: TransactionReferenceType.TRANSFER_IN,
                notes: `Transfer from ${fromAccount.name}. ${dto.notes || ''}`,
            }, em);

            // 3. Create Transfer Record
            const transfer = em.create(AccountTransfer, {
                fromAccount: { id: dto.fromAccountId },
                toAccount: { id: dto.toAccountId },
                amount: dto.amount,
                adminId,
                commissionRate: outTrx.commissionRate || 0,
                commission: outTrx.commission || 0,
                outTransaction: { id: outTrx.id },
                inTransaction: { id: inTrx.id },
                notes: dto.notes,
                createdById: me.id,
            });

            return await em.save(transfer);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPORTS
    // ─────────────────────────────────────────────────────────────────────────

    async exportAccounts(me: any, q: AccountFilterDto) {
        const { records } = await this.listAccounts(me, { ...q, limit: 5000 });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Accounts');

        sheet.columns = [
            { header: 'Account Name', key: 'name', width: 25 },
            { header: 'Type', key: 'type', width: 15 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Balance', key: 'balance', width: 15 },
            { header: 'Initial Balance', key: 'initialBalance', width: 15 },
            { header: 'Bank Name', key: 'bankName', width: 20 },
            { header: 'Owner', key: 'accountOwnerName', width: 25 },
            { header: 'Number', key: 'accountNumber', width: 25 },
            { header: 'Commission Rate', key: 'commissionRate', width: 15 },
            { header: 'Total In', key: 'totalIn', width: 15 },
            { header: 'Total Out', key: 'totalOut', width: 15 },
            { header: 'Status', key: 'status', width: 12 },
        ];

        records.forEach(a => {
            sheet.addRow({
                name: a.name,
                type: a.type,
                currency: a.currency,
                balance: Number(a.currentBalance),
                initialBalance: Number(a.initialBalance),
                bankName: a.bankName,
                accountOwnerName: a.accountOwnerName,
                accountNumber: a.accountNumber,
                commissionRate: Number(a.commissionRate),
                totalIn: Number(a.totalIn),
                totalOut: Number(a.totalOut),
                status: a.status,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }

    async exportTransfers(me: any, q: TransferFilterDto) {
        const { records } = await this.listTransfers(me, { ...q, limit: 10000 });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Transfers');

        sheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Date', key: 'date', width: 22 },
            { header: 'From Account', key: 'fromAccount', width: 25 },
            { header: 'Balance After (From)', key: 'fromBalanceAfter', width: 20 },
            { header: 'To Account', key: 'toAccount', width: 25 },
            { header: 'Balance After (To)', key: 'toBalanceAfter', width: 20 },
            { header: 'Amount', key: 'amount', width: 15 },
            { header: 'Commission', key: 'commission', width: 15 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Created By', key: 'createdBy', width: 25 },
            { header: 'Notes', key: 'notes', width: 40 },
        ];

        records.forEach(tr => {
            sheet.addRow({
                id: tr.id,
                date: new Date(tr.createdAt).toLocaleString(),
                fromAccount: tr.fromAccount?.name,
                fromBalanceAfter: tr.outTransaction ? Number(tr.outTransaction.balanceAfter) : null,
                toAccount: tr.toAccount?.name,
                toBalanceAfter: tr.inTransaction ? Number(tr.inTransaction.balanceAfter) : null,
                amount: Number(tr.amount),
                commission: Number(tr.commission),
                currency: tr.fromAccount?.currency,
                createdBy: tr.createdBy?.name,
                notes: tr.notes,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }

    async exportTransactions(me: any, q: TransactionFilterDto) {
        const { records } = await this.listTransactions(me, { ...q, limit: 10000 });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Transactions');

        sheet.columns = [
            { header: 'TRX #', key: 'number', width: 18 },
            { header: 'Date', key: 'date', width: 22 },
            { header: 'Account', key: 'accountName', width: 25 },
            { header: 'Type', key: 'referenceType', width: 20 },
            { header: 'Metadata', key: 'referenceMeta', width: 35 },
            { header: 'Direction', key: 'direction', width: 12 },
            { header: 'Amount', key: 'amount', width: 15 },
            { header: 'Commission', key: 'commission', width: 15 },
            { header: 'CommissionRate', key: 'commissionRate', width: 15 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Balance After', key: 'balanceAfter', width: 15 },
            { header: 'Created By', key: 'createdBy', width: 25 },
            { header: 'Notes', key: 'notes', width: 40 },
        ];

        records.forEach(t => {
            sheet.addRow({
                number: t.number,
                date: new Date(t.transactionDate).toLocaleString(),
                accountName: t.account?.name,
                referenceType: t.referenceType,
                referenceMeta: formatReferenceMeta(t.referenceMeta),
                direction: t.direction,
                amount: Number(t.amount),
                commission: Number(t.commission),
                commissionRate: Number(t.commissionRate),
                currency: t.account?.currency || t.currency,
                balanceAfter: Number(t.balanceAfter),
                createdBy: t.createdBy?.name,
                notes: t.notes,
            });
        });

        return await workbook.xlsx.writeBuffer();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATS
    // ─────────────────────────────────────────────────────────────────────────

    async getStats(me: any) {
        const adminId = tenantId(me);

        const [accountsSummary, transactionStats] = await Promise.all([
            this.accountRepo.createQueryBuilder('a')
                .select('COUNT(a.id)', 'count')
                .addSelect('SUM(a.currentBalance)', 'totalBalance')
                .where('a.adminId = :adminId', { adminId })
                .getRawOne(),

            this.transactionRepo.createQueryBuilder('t')
                .innerJoin('t.account', 'a')
                .select('t.direction', 'direction')
                .addSelect('SUM(t.amount)', 'total')
                .where('a.adminId = :adminId', { adminId })
                .andWhere('t.status = :status', { status: TransactionStatus.COMPLETED })
                .groupBy('t.direction')
                .getRawMany(),
        ]);

        const stats = {
            accountsCount: Number(accountsSummary?.count || 0),
            totalBalance: Number(accountsSummary?.totalBalance || 0),
            totalIn: 0,
            totalOut: 0,
        };

        transactionStats.forEach(row => {
            if (row.direction === TransactionDirection.IN) stats.totalIn = Number(row.total);
            if (row.direction === TransactionDirection.OUT) stats.totalOut = Number(row.total);
        });

        return stats;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private async generateTrxNumber(em: EntityManager): Promise<string> {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const prefix = `TRX-${today}-`;

        const lastTrx = await em.createQueryBuilder(FinancialTransaction, 't')
            .where('t.number LIKE :prefix', { prefix: `${prefix}%` })
            .orderBy('t.number', 'DESC')
            .getOne();

        let sequence = 1;
        if (lastTrx) {
            const lastSeq = parseInt(lastTrx.number.split('-').pop() || '0', 10);
            sequence = lastSeq + 1;
        }

        return `${prefix}${sequence.toString().padStart(3, '0')}`;
    }
}
