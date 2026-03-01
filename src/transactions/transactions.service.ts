import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemRole, User } from 'entities/user.entity';
import { DataSource, Repository } from 'typeorm';

import { Plan, Subscription, SubscriptionStatus, Transaction, TransactionStatus } from 'entities/plans.entity';
import { ManualCreateTransactionDto } from 'dto/plans.dto';


@Injectable()
export class TransactionsService {
	constructor(
		private dataSource: DataSource,
		@InjectRepository(Transaction) private transactionsRepo: Repository<Transaction>,
		@InjectRepository(User) private usersRepo: Repository<User>,
	) { }

	// ✅ Check if user is super admin
	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
	}

	// ✅ Check if user is admin
	private isAdmin(me: User) {
		return me.role?.name === SystemRole.ADMIN;
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
			.leftJoinAndSelect('sub.plan', 'plan');

		// --- Role-based access ---
		if (this.isAdmin(me)) {
			qb.where(
				'(sub.adminId = :meId OR sub.userId IN (SELECT id FROM users WHERE adminId = :meId))',
				{ meId: me.id },
			);
		} else if (!this.isSuperAdmin(me)) {
			qb.where('sub.userId = :meId', { meId: me.id });
		}

		// --- Filters ---
		if (q?.status) qb.andWhere('t.status = :status', { status: q.status });
		if (q?.userId) qb.andWhere('t.userId = :userId', { userId: q.userId });
		if (q?.planId) qb.andWhere('sub.planId = :planId', { planId: q.planId });

		// Search by user name/email or plan name
		if (search) {
			qb.andWhere(
				`(user.name ILIKE :s OR user.email ILIKE :s OR plan.name ILIKE :s)`,
				{ s: `%${search}%` },
			);
		}

		// Date filters on transaction creation
		if (q?.startDate) {
			qb.andWhere('t.createdAt >= :startDate', {
				startDate: `${q.startDate}T00:00:00.000Z`,
			});
		}
		if (q?.endDate) {
			qb.andWhere('t.createdAt <= :endDate', {
				endDate: `${q.endDate}T23:59:59.999Z`,
			});
		}

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

		// Admin: can see transactions where transaction.adminId === adminId
		if (this.isAdmin(me)) {
			const user = await this.usersRepo.findOne({ where: { id: transaction.userId } });
			if (user && user.adminId === me.id) return transaction;
			throw new ForbiddenException('Not your transaction');
		}

		// Regular user: only their own transactions
		if (transaction.userId === me.id) return transaction;

		throw new ForbiddenException('Not allowed');
	}

	// ✅ Get Transaction Statistics (for admin)
	async getStatistics(me: User) {
		if (!(this.isSuperAdmin(me) || this.isAdmin(me))) {
			throw new ForbiddenException('Not allowed');
		}

		const qb = this.transactionsRepo.createQueryBuilder('t');

		if (this.isSuperAdmin(me)) {
			qb.where('t.adminId IS NULL');
		} else {
			qb.where('t.adminId = :meId', { meId: me.id });
		}

		const result = await qb
			.select([
				'COUNT(*) as total',
				`COUNT(CASE WHEN t.status = :active THEN 1 END) as active`,
				`COUNT(CASE WHEN t.status = :processing THEN 1 END) as processing`,
				`COUNT(CASE WHEN t.status = :completed THEN 1 END) as completed`,
				`COUNT(CASE WHEN t.status = :cancelled THEN 1 END) as cancelled`,
				'COALESCE(SUM(t.amount), 0) as totalRevenue',
			])
			.setParameters({
				active: TransactionStatus.ACTIVE,
				processing: TransactionStatus.PROCESSING,
				completed: TransactionStatus.COMPLETED,
				cancelled: TransactionStatus.CANCELLED,
			})
			.getRawOne();

		return {
			total: Number(result.total),
			active: Number(result.active),
			processing: Number(result.processing),
			completed: Number(result.completed),
			cancelled: Number(result.cancelled),
			totalRevenue: Number(result.totalRevenue),
		};
	}

	// ✅ Cancel Transaction (by user or admin)
	async cancel(me: User, id: number) {
		const transaction = await this.get(me, id);

		// Can only cancel if processing
		if (transaction.status !== TransactionStatus.PROCESSING) {
			throw new BadRequestException('Can only cancel processing transactions');
		}

		transaction.status = TransactionStatus.CANCELLED;

		return this.transactionsRepo.save(transaction);
	}

	async manualCreateCompletedTransaction(
		me: User,
		dto: ManualCreateTransactionDto,
	) {
		if (!this.isSuperAdmin(me)) {
			throw new ForbiddenException(
				'Only super admin can manually create completed transactions',
			);
		}

		return this.dataSource.transaction(async (manager) => {
			// ✅ Ensure subscription exists
			const subscription = await manager.findOne(Subscription, {
				where: { id: dto.subscriptionId },
			});

			if (!subscription) {
				throw new NotFoundException('Subscription not found');
			}

			// ✅ Create new transaction
			const transaction = manager.create(Transaction, {
				subscriptionId: dto.subscriptionId,
				amount: subscription.price,
				paymentMethod: dto.paymentMethod,
				paymentProof: dto.paymentProof ?? null,
				status: TransactionStatus.COMPLETED,
			});

			await manager.save(Transaction, transaction);

			// ✅ Optional: activate subscription if not active
			if (subscription.status !== SubscriptionStatus.ACTIVE) {
				subscription.status = SubscriptionStatus.ACTIVE;
				await manager.save(Subscription, subscription);
			}

			return transaction;
		});
	}
}