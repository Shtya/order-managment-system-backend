import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemRole, User } from 'entities/user.entity';
import { Between, Repository } from 'typeorm';
import { CreatePlanDto, UpdatePlanDto } from 'dto/plans.dto';
import { Plan } from 'entities/plans.entity';

@Injectable()
export class PlansService {
	constructor(
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

	// ✅ List Plans (filtered by user role)
	async list(me: User) {
		const qb = this.plansRepo
			.createQueryBuilder('p')
			.orderBy('p.id', 'DESC');

		// Super admin: sees all plans with adminId null
		if (this.isSuperAdmin(me)) {
			qb.where('p.adminId IS NULL');
			return qb.getMany();
		}

		// Admin: sees global plans + his own
		if (this.isAdmin(me)) {
			qb.where('(p.adminId IS NULL OR p.adminId = :meId)', { meId: me.id });
			return qb.getMany();
		}

		// Regular user: sees only global active plans
		qb.where('p.adminId IS NULL')
			.andWhere('p.isActive = :active', { active: true });

		return qb.getMany();
	}

	// ✅ Get Single Plan
	async get(me: User, id: number) {
		const plan = await this.plansRepo.findOne({ where: { id } });
		if (!plan) throw new NotFoundException('Plan not found');

		// Super admin: only plans with adminId null
		if (this.isSuperAdmin(me)) {
			if (plan.adminId === null) return plan;
			throw new ForbiddenException('Not allowed');
		}

		// Admin: global or owned by him
		if (this.isAdmin(me)) {
			if (plan.adminId === null || plan.adminId === me.id) return plan;
			throw new ForbiddenException('Not your plan');
		}

		// Regular user: only global active plans
		if (plan.adminId === null && plan.isActive) return plan;

		throw new ForbiddenException('Not allowed');
	}

	// ✅ Create Plan
	async create(me: User, dto: CreatePlanDto) {
		// Only super admin and admin can create plans
		if (!(this.isSuperAdmin(me) || this.isAdmin(me))) {
			throw new ForbiddenException('Not allowed');
		}

		// Check if plan name already exists
		const exists = await this.plansRepo.findOne({ where: { name: dto.name } });
		if (exists) throw new BadRequestException('Plan name already exists');

		const plan = this.plansRepo.create({
			name: dto.name,
			price: dto.price,
			duration: dto.duration,
			description: dto.description,
			features: dto.features || [],
			color: dto.color || 'from-blue-500 to-blue-600',
			isActive: dto.isActive !== undefined ? dto.isActive : true,
			isPopular: dto.isPopular,
			usersLimit: dto.usersLimit ?? 1,
			shippingCompaniesLimit: dto.shippingCompaniesLimit ?? 0,
			adminId: this.isSuperAdmin(me) ? null : me.id,
		});

		return this.plansRepo.save(plan);
	}

	// ✅ Update Plan
	async update(me: User, id: number, dto: UpdatePlanDto) {
		const plan = await this.get(me, id);

		// Only owner or super admin can update
		if (!this.isSuperAdmin(me) && plan.adminId !== me.id) {
			throw new ForbiddenException('Not your plan');
		}

		// Check name uniqueness if changing name
		if (dto.name && dto.name !== plan.name) {
			const exists = await this.plansRepo.findOne({ where: { name: dto.name } });
			if (exists) throw new BadRequestException('Plan name already exists');
		}

		// Update fields
		if (dto.name !== undefined) plan.name = dto.name;
		if (dto.price !== undefined) plan.price = dto.price;
		if (dto.duration !== undefined) plan.duration = dto.duration;
		if (dto.description !== undefined) plan.description = dto.description;
		if (dto.features !== undefined) plan.features = dto.features;
		if (dto.color !== undefined) plan.color = dto.color;
		if (dto.isActive !== undefined) plan.isActive = dto.isActive;
		if (dto.isPopular !== undefined) plan.isPopular = dto.isPopular;
		if (dto.usersLimit !== undefined) plan.usersLimit = dto.usersLimit;
		if (dto.shippingCompaniesLimit !== undefined)
			plan.shippingCompaniesLimit = dto.shippingCompaniesLimit;

		return this.plansRepo.save(plan);
	}

	// ✅ Delete Plan
	async remove(me: User, id: number) {
		const plan = await this.get(me, id);

		// Only owner or super admin can delete
		if (!this.isSuperAdmin(me) && plan.adminId !== me.id) {
			throw new ForbiddenException('Not your plan');
		}

		// Check if plan has active transactions
		const activeTransactions = await this.plansRepo
			.createQueryBuilder('p')
			.innerJoin('p.transactions', 't')
			.where('p.id = :planId', { planId: id })
			.andWhere('t.status IN (:...statuses)', {
				statuses: ['نشط', 'تحويل جاري'],
			})
			.getCount();

		if (activeTransactions > 0) {
			throw new BadRequestException(
				'Cannot delete plan with active transactions. Deactivate it instead.',
			);
		}

		await this.plansRepo.delete(id);

		return { message: 'Plan deleted successfully' };
	}

	// ✅ Get Available Plans (for users)
	async getAvailablePlans() {
		return this.plansRepo.find({
			where: {
				isActive: true,
				adminId: null, // Only global plans
			},
			order: { price: 'ASC' },
		});
	}

	// ✅ Get Plan Statistics (for admin)
	async getStatistics(me: User) {
		if (!(this.isSuperAdmin(me) || this.isAdmin(me))) {
			throw new ForbiddenException('Not allowed');
		}

		const qb = this.plansRepo.createQueryBuilder('p');

		if (this.isSuperAdmin(me)) {
			qb.where('p.adminId IS NULL');
		} else {
			qb.where('(p.adminId IS NULL OR p.adminId = :meId)', { meId: me.id });
		}

		const total = await qb.getCount();
		const active = await qb.andWhere('p.isActive = :active', { active: true }).getCount();

		return {
			total,
			active,
			inactive: total - active,
		};
	}
}