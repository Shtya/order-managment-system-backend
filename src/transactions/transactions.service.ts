import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemRole, User } from 'entities/user.entity';
import { DataSource, Repository } from 'typeorm';
import { DateFilterUtil } from 'common/date-filter.util';
import * as ExcelJS from "exceljs";
import { imageSrc } from 'common/healpers';
import { TransactionEntity, TransactionStatus } from 'entities/payments.entity';


@Injectable()
export class TransactionsService {
	constructor(
		@InjectRepository(TransactionEntity) private transactionsRepo: Repository<TransactionEntity>,
	) { }

	// ✅ Check if user is super admin
	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
	}

	// ✅ Check if user is admin
	private isAdmin(me: User) {
		return me.role?.name === SystemRole.ADMIN;
	}

	public async generateTransactionNumber(adminId: string): Promise<string> {
		const date = new Date();
		const dateStr = date.toISOString().split("T")[0].replace(/-/g, ""); // YYYYMMDD
		const prefix = `TRX-${dateStr}`;

		//
		const lastTransaction = await this.transactionsRepo
			.createQueryBuilder("t")
			.where("t.userId = :adminId", { adminId })
			.andWhere("t.number LIKE :prefix", { prefix: `${prefix}%` })
			.orderBy("t.id", "DESC")
			.getOne();

		let sequence = 1;
		if (lastTransaction?.number) {

			const lastNum = lastTransaction.number.split("-").pop();
			sequence = parseInt(lastNum || "0") + 1;
		}


		return `${prefix}-${String(sequence).padStart(3, "0")}`.trim();
	}

	async list(me: User, q?: any) {
		const page = Number(q?.page ?? 1);
		const limit = Number(q?.limit ?? 10);
		const search = String(q?.search ?? '').trim();

		const sortBy = String(q?.sortBy ?? 'createdAt');
		const sortDir: 'ASC' | 'DESC' =
			String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

		const qb = this.transactionsRepo
			.createQueryBuilder('t')
			.leftJoinAndSelect('t.user', 'user')
			.leftJoinAndSelect('t.subscription', 'sub')
			.leftJoinAndSelect('sub.plan', 'plan')

			.leftJoinAndSelect('t.userFeature', 'userFeature')
			.leftJoinAndSelect('userFeature.feature', 'feature');


		if (!this.isSuperAdmin(me)) {
			qb.where('t.userId = :meId', { meId: me.id });
		}
		const allowedPurposes = q?.allowedPurposes;
		if (allowedPurposes && Array.isArray(allowedPurposes) && allowedPurposes.length > 0) {
			qb.andWhere('t.purpose IN (:...allowedPurposes)', { allowedPurposes });
		}

		// --- Filters ---
		if (q?.status) qb.andWhere('t.status = :status', { status: q.status });
		if (q?.userId) qb.andWhere('t.userId = :userId', { userId: q.userId });
		if (q?.planId) qb.andWhere('sub.planId = :planId', { planId: q.planId });

		if (q?.purpose) qb.andWhere('t.purpose = :purpose', { purpose: q.purpose });


		// Search by user name/email or plan name
		if (search) {
			qb.andWhere(
				`(user.name ILIKE :s OR user.email ILIKE :s OR plan.name ILIKE :s)`,
				{ s: `%${search}%` },
			);
		}

		// Date filters on transaction creation
		DateFilterUtil.applyToQueryBuilder(qb, 't.createdAt', q?.startDate, q?.endDate);

		if (q?.subscriptionId) {
			qb.andWhere('t.subscriptionId = :subscriptionId', {
				subscriptionId: q?.subscriptionId,
			});
		}

		// --- Sorting ---
		qb.orderBy(`t.${sortBy}`, sortDir);

		// --- Pagination ---
		const [transactions, total] = await qb
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		// Return as-is with relations
		return {
			total_records: total,
			current_page: page,
			per_page: limit,
			records: transactions,
		};
	}

	async get(me: User, id: number) {
		const transaction = await this.transactionsRepo.findOne({
			where: { id },
			relations: ['user', 'subscription', 'subscription.plan'],
		});

		if (!transaction) throw new NotFoundException('Transaction not found');

		// Super admin: can see all
		if (this.isSuperAdmin(me)) {
			return transaction;
		}


		// Regular user: only their own transactions
		if (transaction.userId === me.id) return transaction;

		throw new ForbiddenException('Not allowed');
	}

	// ✅ Get Transaction Statistics (for admin)
	// ✅ Get Transaction Statistics
	async getStatistics(me: User) {
		// 1. Authorization Check
		if (!this.isSuperAdmin(me) && !this.isAdmin(me)) {
			throw new ForbiddenException('Not allowed');
		}

		const qb = this.transactionsRepo.createQueryBuilder('t');

		// 2. Ownership Filter
		if (!this.isSuperAdmin(me)) {
			// Super admin sees global platform revenue/transactions
			qb.where('t.userId = :meId', { meId: me.id });
		}
		// 3. Aggregation with new Statuses
		const result = await qb
			.select([
				'COUNT(*) as total',
				'COUNT(CASE WHEN t.status = :success THEN 1 END) as success',
				'COUNT(CASE WHEN t.status = :pending THEN 1 END) as pending',
				'COUNT(CASE WHEN t.status = :failed THEN 1 END) as failed',
				'COUNT(CASE WHEN t.status = :cancelled THEN 1 END) as cancelled',
				'COUNT(CASE WHEN t.status = :refunded THEN 1 END) as refunded',
				'COALESCE(SUM(CASE WHEN t.status = :success THEN t.amount ELSE 0 END), 0) as totalRevenue',
			])
			.setParameters({
				success: TransactionStatus.SUCCESS,
				pending: TransactionStatus.PENDING,
				failed: TransactionStatus.FAILED,
				cancelled: TransactionStatus.CANCELLED,
				refunded: TransactionStatus.REFUNDED,
			})
			.getRawOne();

		// 4. Return formatted numbers
		return {
			total: Number(result.total || 0),
			success: Number(result.success || 0),
			pending: Number(result.pending || 0),
			failed: Number(result.failed || 0),
			cancelled: Number(result.cancelled || 0),
			refunded: Number(result.refunded || 0),
			totalRevenue: Number(result.totalRevenue || 0),
		};
	}
	// ✅ Cancel Transaction (by user or admin)
	async cancel(me: User, id: number) {
		const transaction = await this.get(me, id);

		// Can only cancel if processing
		if (transaction.status !== TransactionStatus.PENDING) {
			throw new BadRequestException(
				`Cannot cancel transaction with status: ${transaction.status}. Only pending transactions can be cancelled.`
			);
		}

		transaction.status = TransactionStatus.CANCELLED;

		return this.transactionsRepo.save(transaction);
	}


	async exportTransactions(me: User, q?: any) {
		const search = String(q?.search ?? '').trim();
		const sortBy = String(q?.sortBy ?? 'createdAt');
		const sortDir: 'ASC' | 'DESC' = String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

		const qb = this.transactionsRepo
			.createQueryBuilder('t')
			.leftJoinAndSelect('t.user', 'user')
			.leftJoinAndSelect('t.subscription', 'sub')
			.leftJoinAndSelect('sub.plan', 'plan')

			.leftJoinAndSelect('t.userFeature', 'userFeature')
			.leftJoinAndSelect('userFeature.feature', 'feature');

		// --- منطق الصلاحيات (Role-based access) ---
		if (!this.isSuperAdmin(me)) {
			qb.where('sub.userId = :meId', { meId: me.id });
		}

		// --- الفلاتر ---
		if (q?.status) qb.andWhere('t.status = :status', { status: q.status });
		if (q?.userId) qb.andWhere('t.userId = :userId', { userId: q.userId });
		if (q?.planId) qb.andWhere('sub.planId = :planId', { planId: q.planId });

		if (q?.purpose) qb.andWhere('t.purpose = :purpose', { purpose: q.purpose });


		if (search) {
			qb.andWhere(
				`(user.name ILIKE :s OR user.email ILIKE :s OR plan.name ILIKE :s OR t.number ILIKE :s)`,
				{ s: `%${search}%` },
			);
		}

		const transactions = await qb.orderBy(`t.${sortBy}`, sortDir).getMany();

		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("Transactions");

		// 1. تحديد الأعمدة بنفس ترتيب الـ Front-end
		worksheet.columns = [
			{ header: "Transaction ID", key: "number", width: 20 },
			{ header: "User Name", key: "userName", width: 25 },
			{ header: "User Email", key: "userEmail", width: 25 },
			{ header: "Purpose", key: "purpose", width: 20 },      // عمود جديد
			{ header: "Subscription", key: "planName", width: 20 },
			{ header: "Feature", key: "featureName", width: 25 },  // عمود جديد
			{ header: "Amount", key: "amount", width: 15 },
			{ header: "Status", key: "status", width: 15 },
			{ header: "Payment Method", key: "paymentMethod", width: 20 },
			{ header: "Payment Proof (URL)", key: "paymentProof", width: 40 },
			{ header: "Created At", key: "createdAt", width: 20 },
			{ header: "Last Update", key: "updatedAt", width: 20 },
		];

		// 2. تحويل البيانات وتجهيزها (Transform)
		const rows = transactions.map(t => {
			return {
				number: t.number?.trim() || '—',
				userName: t.user?.name?.trim() || '—',
				userEmail: t.user?.email?.trim() || '—',
				purpose: t.purpose?.replace(/_/g, ' ').toUpperCase() || '—', // تنسيق النص (مثلاً: WALLET TOP UP)
				planName: t.subscription?.plan?.name?.trim() || '—',
				featureName: t.userFeature?.feature?.name?.trim() || '—',
				amount: Number(t.amount || 0),
				status: t.status?.toUpperCase() || '—',
				paymentMethod: t.paymentMethod?.toUpperCase() || '—',
				paymentProof: t.paymentProof ? imageSrc(t.paymentProof) : '—',
				createdAt: t.createdAt ? new Date(t.createdAt).toLocaleString() : '—', // استخدام Time أيضاً في الإكسل
				updatedAt: t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—',
			};
		});
		worksheet.addRows(rows);

		// تنسيق الصف الأول (Header)
		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

		return await workbook.xlsx.writeBuffer();
	}
}