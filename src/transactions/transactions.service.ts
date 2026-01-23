import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemRole, User } from 'entities/user.entity';
import { Between, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
	CreateTransactionDto,
	FilterTransactionsDto,
	UpdateTransactionStatusDto,
} from 'dto/plans.dto';
import { Plan, Transaction, TransactionStatus } from 'entities/plans.entity';

@Injectable()
export class TransactionsService {
	constructor(
		@InjectRepository(Transaction) private transactionsRepo: Repository<Transaction>,
		@InjectRepository(Plan) private plansRepo: Repository<Plan>,
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

	// ✅ List Transactions (filtered by user role)
	async list(me: User, filters?: FilterTransactionsDto) {
		const qb = this.transactionsRepo
			.createQueryBuilder('t')
			.leftJoinAndSelect('t.user', 'user')
			.leftJoinAndSelect('t.plan', 'plan')
			.orderBy('t.id', 'DESC');

		// Super admin: sees all transactions
		if (this.isSuperAdmin(me)) {
			qb.where('t.adminId IS NULL');
		}
		// Admin: sees transactions for his users
		else if (this.isAdmin(me)) {
			qb.where('(t.adminId = :meId OR t.userId IN (SELECT id FROM users WHERE adminId = :meId))', {
				meId: me.id,
			});
		}
		// Regular user: sees only his own transactions
		else {
			qb.where('t.userId = :meId', { meId: me.id });
		}

		// Apply filters
		if (filters) {
			if (filters.status) {
				qb.andWhere('t.status = :status', { status: filters.status });
			}

			if (filters.userId) {
				qb.andWhere('t.userId = :userId', { userId: filters.userId });
			}

			if (filters.planId) {
				qb.andWhere('t.planId = :planId', { planId: filters.planId });
			}

			if (filters.dateFrom) {
				qb.andWhere('t.createdAt >= :dateFrom', { dateFrom: new Date(filters.dateFrom) });
			}

			if (filters.dateTo) {
				qb.andWhere('t.createdAt <= :dateTo', { dateTo: new Date(filters.dateTo) });
			}

			if (filters.minAmount !== undefined) {
				qb.andWhere('t.amount >= :minAmount', { minAmount: filters.minAmount });
			}

			if (filters.maxAmount !== undefined) {
				qb.andWhere('t.amount <= :maxAmount', { maxAmount: filters.maxAmount });
			}
		}

		const transactions = await qb.getMany();

		// Format response with user and plan names
		return transactions.map((t) => ({
			id: t.id,
			userId: t.userId,
			userName: t.user?.name || 'Unknown',
			userEmail: t.user?.email || 'Unknown',
			planId: t.planId,
			planName: t.plan?.name || 'Unknown',
			amount: Number(t.amount),
			status: t.status,
			paymentMethod: t.paymentMethod,
			paymentProof: t.paymentProof,
			date: t.createdAt.toLocaleDateString('ar-EG'),
			createdAt: t.createdAt,
			updatedAt: t.updatedAt,
		}));
	}

	// ✅ Get Single Transaction
	async get(me: User, id: number) {
		const transaction = await this.transactionsRepo.findOne({
			where: { id },
			relations: ['user', 'plan'],
		});

		if (!transaction) throw new NotFoundException('Transaction not found');

		// Super admin: only transactions with adminId null
		if (this.isSuperAdmin(me)) {
			if (transaction.adminId === null) return transaction;
			throw new ForbiddenException('Not allowed');
		}

		// Admin: transactions for his users
		if (this.isAdmin(me)) {
			const user = await this.usersRepo.findOne({ where: { id: transaction.userId } });
			if (user && user.adminId === me.id) return transaction;
			throw new ForbiddenException('Not your transaction');
		}

		// Regular user: only his own transactions
		if (transaction.userId === me.id) return transaction;

		throw new ForbiddenException('Not allowed');
	}

	// ✅ Create Transaction (Subscribe to Plan)
	async create(me: User, dto: CreateTransactionDto) {
		// Find the plan
		const plan = await this.plansRepo.findOne({ where: { id: dto.planId } });
		if (!plan) throw new NotFoundException('Plan not found');

		// Check if plan is active
		if (!plan.isActive) {
			throw new BadRequestException('Plan is not active');
		}

		// Determine userId (admin can create for specific user)
		let userId = me.id;
		if (dto.userId && (this.isSuperAdmin(me) || this.isAdmin(me))) {
			// Admin can only create for his users
			if (this.isAdmin(me)) {
				const targetUser = await this.usersRepo.findOne({ where: { id: dto.userId } });
				if (!targetUser || targetUser.adminId !== me.id) {
					throw new ForbiddenException('Not your user');
				}
			}
			userId = dto.userId;
		}

		// Create transaction
		const transaction = this.transactionsRepo.create({
			userId,
			planId: plan.id,
			amount: plan.price,
			status: TransactionStatus.PROCESSING,
			paymentMethod: dto.paymentMethod,
			paymentProof: dto.paymentProof,
			adminId: this.isSuperAdmin(me) ? null : this.isAdmin(me) ? me.id : me.adminId,
		});

		const saved = await this.transactionsRepo.save(transaction);

		// Return full transaction with relations
		return this.transactionsRepo.findOne({
			where: { id: saved.id },
			relations: ['user', 'plan'],
		});
	}

	// ✅ Update Transaction Status (Admin only)
	async updateStatus(me: User, id: number, dto: UpdateTransactionStatusDto) {
		if (!(this.isSuperAdmin(me) || this.isAdmin(me))) {
			throw new ForbiddenException('Only admins can update transaction status');
		}

		const transaction = await this.get(me, id);

		transaction.status = dto.status;

		return this.transactionsRepo.save(transaction);
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

		const total = await qb.getCount();

		const active = await qb
			.clone()
			.andWhere('t.status = :status', { status: TransactionStatus.ACTIVE })
			.getCount();

		const processing = await qb
			.clone()
			.andWhere('t.status = :status', { status: TransactionStatus.PROCESSING })
			.getCount();

		const completed = await qb
			.clone()
			.andWhere('t.status = :status', { status: TransactionStatus.COMPLETED })
			.getCount();

		const cancelled = await qb
			.clone()
			.andWhere('t.status = :status', { status: TransactionStatus.CANCELLED })
			.getCount();

		// Calculate total revenue
		const result = await qb
			.select('SUM(t.amount)', 'total')
			.getRawOne();

		return {
			total,
			active,
			processing,
			completed,
			cancelled,
			totalRevenue: Number(result?.total || 0),
		};
	}

	// ✅ Get User's Active Subscription
	async getActiveSubscription(userId: number) {
		const transaction = await this.transactionsRepo.findOne({
			where: {
				userId,
				status: TransactionStatus.ACTIVE,
			},
			relations: ['plan'],
			order: { createdAt: 'DESC' },
		});

		return transaction;
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
}