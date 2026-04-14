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
import { Plan, PlanType, Subscription, SubscriptionStatus } from 'entities/plans.entity';

@Injectable()
export class PlansService {
	constructor(
		@InjectRepository(Plan) private plansRepo: Repository<Plan>,
		@InjectRepository(Subscription) private subscriptionRepo: Repository<Subscription>,
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
		// if (this.isSuperAdmin(me)) {
		// 	qb.where('p.adminId IS NULL');
		// 	return qb.getMany();
		// }

		// // Admin: sees global plans + his own
		// if (this.isAdmin(me)) {
		// 	qb.where('(p.adminId IS NULL OR p.adminId = :meId)', { meId: me.id });
		// 	return qb.getMany();
		// }

		// // Regular user: sees only global active plans
		// qb.where('p.adminId IS NULL')
		// 	.andWhere('p.isActive = :active', { active: true });

		return qb.getMany();
	}

	// ✅ Get Single Plan
	async get(me: User, id: string) {
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
		// 1. Authorization Check
		if (!this.isSuperAdmin(me)) {
			throw new ForbiddenException('Only Super Admins can create global plans');
		}

		// 2. Conflict Check
		const exists = await this.plansRepo.findOne({ where: { name: dto.name } });
		if (exists) throw new BadRequestException('Plan name already exists');

		// 3. Entity Creation
		const plan = this.plansRepo.create({
			name: dto.name?.trim(),
			type: dto.type ?? PlanType.STANDARD,
			duration: dto.duration,
			//
			durationIndays: dto.durationIndays !== undefined ? dto.durationIndays : null,


			price: dto.price,
			extraOrderFee: dto.extraOrderFee !== undefined ? dto.extraOrderFee : null,


			includedOrders: dto.includedOrders !== undefined ? dto.includedOrders : null,
			usersLimit: dto.usersLimit !== undefined ? dto.usersLimit : 1,
			storesLimit: dto.storesLimit !== undefined ? dto.storesLimit : 1,
			shippingCompaniesLimit: dto.shippingCompaniesLimit !== undefined ? dto.shippingCompaniesLimit : 0,
			bulkUploadPerMonth: dto.bulkUploadPerMonth ?? 0,

			description: dto.description?.trim(),
			features: dto.features || [],
			color: dto.color || 'from-blue-500 to-blue-600',
			isActive: dto.isActive ?? true,
			isPopular: dto.isPopular ?? false,
			adminId: null,
		});

		return this.plansRepo.save(plan);
	}
	// ✅ Update Plan
	// ✅ Update Plan
	async update(me: User, id: string, dto: UpdatePlanDto) {
		const plan = await this.get(me, id);

		// 1. Authorization: Only Super Admin or the Plan Owner can update
		if (!this.isSuperAdmin(me) && plan.adminId !== me.id) {
			throw new ForbiddenException('Not your plan');
		}

		// 2. Uniqueness Check if name is changing
		if (dto.name && dto.name.trim() !== plan.name) {
			const exists = await this.plansRepo.findOne({
				where: { name: dto.name.trim() }
			});
			if (exists) throw new BadRequestException('Plan name already exists');
		}

		// 3. Manual Property Mapping (Explicit assignment)

		// Identity & Type
		if (dto.name !== undefined) plan.name = dto.name.trim();
		if (dto.type !== undefined) plan.type = dto.type;
		if (dto.duration !== undefined) plan.duration = dto.duration;
		if (dto.durationIndays !== undefined) plan.durationIndays = dto.durationIndays;

		// Pricing Logic
		if (dto.price !== undefined) plan.price = dto.price;
		if (dto.extraOrderFee !== undefined) plan.extraOrderFee = dto.extraOrderFee;

		// Limits
		if (dto.includedOrders !== undefined) plan.includedOrders = dto.includedOrders;
		if (dto.usersLimit !== undefined) plan.usersLimit = dto.usersLimit;
		if (dto.storesLimit !== undefined) plan.storesLimit = dto.storesLimit;
		if (dto.shippingCompaniesLimit !== undefined) plan.shippingCompaniesLimit = dto.shippingCompaniesLimit;
		if (dto.bulkUploadPerMonth !== undefined) plan.bulkUploadPerMonth = dto.bulkUploadPerMonth;

		// Metadata & UI
		if (dto.description !== undefined) plan.description = dto.description.trim();
		if (dto.features !== undefined) plan.features = dto.features;
		if (dto.color !== undefined) plan.color = dto.color;
		if (dto.isActive !== undefined) plan.isActive = dto.isActive;
		if (dto.isPopular !== undefined) plan.isPopular = dto.isPopular;

		return await this.plansRepo.save(plan);
	}

	// ✅ Delete Plan
	// ✅ Delete Plan
	async remove(me: User, id: string) {
		const plan = await this.get(me, id);

		// 1. Authorization Check: Only owner or super admin
		if (!this.isSuperAdmin(me) && plan.adminId !== me.id) {
			throw new ForbiddenException('Not your plan');
		}

		const activeSubscriptionCount = await this.subscriptionRepo.count({
			where: {
				planId: id,
				status: SubscriptionStatus.ACTIVE
			}
		});

		if (activeSubscriptionCount > 0) {
			throw new BadRequestException(
				`Cannot delete plan. There are ${activeSubscriptionCount} users currently using this plan. Please deactivate it instead so new users cannot join.`
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