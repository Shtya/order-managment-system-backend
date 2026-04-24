import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Company, OnboardingStatus, OnboardingStep, Role, SystemRole, User } from 'entities/user.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Plan, Subscription, SubscriptionStatus } from 'entities/plans.entity';
import { AdminCreateDto, UpdateMeUserDto, UpdateUserDto, UpsertCompanyDto } from 'dto/user.dto';
import { SubscriptionsService } from 'src/subscription/subscription.service';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { tenantId } from 'src/category/category.service';


@Injectable()
export class UsersService {
	constructor(
		private dataSource: DataSource,
		@InjectRepository(User) private usersRepo: Repository<User>,
		@InjectRepository(Role) private rolesRepo: Repository<Role>,
		@InjectRepository(Plan) private plansRepo: Repository<Plan>, // ✅ NEW
		@InjectRepository(Subscription) private subscriptionsRepo: Repository<Subscription>, // ✅ NEW

		@Inject(forwardRef(() => SubscriptionsService))
		private readonly subscriptionsService: SubscriptionsService,

	) { }

	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
	}


	async getFullUser(userId: string): Promise<User> {
		const user = await this.usersRepo.createQueryBuilder('user')
			// Join Role
			.leftJoinAndSelect('user.role', 'role')
			.leftJoinAndSelect('user.admin', 'admin')
			// Join only the ACTIVE subscription
			.leftJoinAndSelect(
				'user.subscriptions',
				'ownSub',
				'ownSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('ownSub.plan', 'ownPlan')

			.leftJoinAndSelect(
				'admin.subscriptions',
				'adminSub',
				'adminSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('adminSub.plan', 'adminPlan')

			.where('user.id = :userId', { userId })
			.getOne();

		if (!user) {
			throw new NotFoundException(`User with ID ${userId} not found`);
		}

		const isAdmin = user.role?.name === SystemRole.ADMIN;
		const effectiveSub = (isAdmin || !user.admin)
			? user.subscriptions?.[0]
			: user.admin?.subscriptions?.[0];

		user.subscriptions = effectiveSub ? [effectiveSub] : [];

		delete user.admin;

		return user;
	}

	async getFullUserByEmail(email: string): Promise<User> {
		const user = await this.usersRepo.createQueryBuilder('user')
			// Join Role
			.leftJoinAndSelect('user.role', 'role')
			.leftJoinAndSelect('user.admin', 'admin')
			// Join only the ACTIVE subscription
			.leftJoinAndSelect(
				'user.subscriptions',
				'ownSub',
				'ownSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('ownSub.plan', 'ownPlan')

			.leftJoinAndSelect(
				'admin.subscriptions',
				'adminSub',
				'adminSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('adminSub.plan', 'adminPlan')

			.where('user.email = :email', { email })
			.getOne();

		if (!user) {
			throw new NotFoundException(`User with email ${email} not found`);
		}

		const isAdmin = user.role?.name === SystemRole.ADMIN;
		const effectiveSub = (isAdmin || !user.admin)
			? user.subscriptions?.[0]
			: user.admin?.subscriptions?.[0];

		user.subscriptions = effectiveSub ? [effectiveSub] : [];

		delete user.admin;

		return user;
	}

	async superAdminList(
		me: User,
		opts: {
			page: number;
			limit: number;
			tab: string;
			search: string;
			role: string;
			active: string;
			adminId: string;
		}
	) {
		// ✅ enforce SUPER_ADMIN only
		if (!this.isSuperAdmin(me)) {
			throw new ForbiddenException('Super admin only');
		}

		const page = Math.max(1, Number(opts.page || 1));
		const limit = Math.min(100, Math.max(1, Number(opts.limit || 10)));
		const skip = (page - 1) * limit;

		const tab = (opts.tab || 'all').toLowerCase();
		const search = (opts.search || '').trim();
		const roleContains = (opts.role || '').trim();
		const active = (opts.active || 'all').toLowerCase();
		const adminId = (opts.adminId || '').trim();

		// base query
		const qb = this.usersRepo
			.createQueryBuilder('u')
			.leftJoinAndSelect('u.role', 'role')
			.leftJoinAndSelect(
				'u.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('subscription.plan', 'plan')
			// ✅ self join to get admin info (owner)
			.leftJoin(User, 'admin', 'admin.id = u.adminId')
			.addSelect(['admin.id', 'admin.name', 'admin.email'])
			.orderBy('u.id', 'DESC');

		// tab filter
		if (tab === 'active') qb.andWhere('u.isActive = true');
		if (tab === 'inactive') qb.andWhere('u.isActive = false');

		// active filter (extra)
		if (active === 'true') qb.andWhere('u.isActive = true');
		if (active === 'false') qb.andWhere('u.isActive = false');

		// adminId filter
		if (adminId) qb.andWhere('u.adminId = :adminId', { adminId: adminId });

		// search
		if (search) {
			qb.andWhere('(u.name LIKE :q OR u.email LIKE :q)', { q: `%${search}%` });
		}

		// role contains
		if (roleContains) {
			qb.andWhere('role.name LIKE :r', { r: `%${roleContains}%` });
		}

		// count (total with current filters)
		const total_records = await qb.getCount();

		// page data
		const rows = await qb.skip(skip).take(limit).getRawAndEntities();

		// entities are in rows.entities, admin fields in rows.raw
		const records = rows.entities.map((u, idx) => {
			const raw = rows.raw[idx] || {};
			const activeSub = u.activeSubscription ?? null;
			return {
				id: u.id,
				name: u.name,
				email: u.email,
				isActive: u.isActive,
				adminId: u.adminId ?? null,
				subscription: activeSub ?? null,
				// subscriptionId: u.subscriptionId ?? null,

				// extra info
				role: u.role ? { id: u.role.id, name: u.role.name } : null,
				plan: activeSub ? { id: activeSub.id, name: activeSub.plan?.name } : null,

				admin: raw?.admin_id
					? { id: raw.admin_id, name: raw.admin_name, email: raw.admin_email }
					: null,

				// if your entity has createdAt
				createdAt: (u as any).createdAt ?? null,
			};
		});

		// stats (same filters except pagination)
		// For stats, we reuse qb but without skip/take:
		const qbStats = this.usersRepo
			.createQueryBuilder('u')
			.leftJoin('u.role', 'role');

		// apply same filters
		if (tab === 'active') qbStats.andWhere('u.isActive = true');
		if (tab === 'inactive') qbStats.andWhere('u.isActive = false');
		if (active === 'true') qbStats.andWhere('u.isActive = true');
		if (active === 'false') qbStats.andWhere('u.isActive = false');
		if (adminId) qbStats.andWhere('u.adminId = :adminId', { adminId: adminId });
		if (search) qbStats.andWhere('(u.name LIKE :q OR u.email LIKE :q)', { q: `%${search}%` });
		if (roleContains) qbStats.andWhere('role.name LIKE :r', { r: `%${roleContains}%` });

		const total = await qbStats.getCount();
		const activeCount = await qbStats.clone().andWhere('u.isActive = true').getCount();
		const inactiveCount = await qbStats.clone().andWhere('u.isActive = false').getCount();

		return {
			records,
			total_records,
			current_page: page,
			per_page: limit,
			stats: { total, active: activeCount, inactive: inactiveCount },
		};
	}

	async superAdminExportCsv(
		me: User,
		opts: { tab: string; search: string; role: string; active: string; adminId: string }
	) {
		if (!this.isSuperAdmin(me)) throw new ForbiddenException('Super admin only');

		const tab = (opts.tab || 'all').toLowerCase();
		const search = (opts.search || '').trim();
		const roleContains = (opts.role || '').trim();
		const active = (opts.active || 'all').toLowerCase();
		const adminId = (opts.adminId || '').trim();

		const qb = this.usersRepo
			.createQueryBuilder('u')
			.leftJoinAndSelect('u.role', 'role')
			.leftJoinAndSelect(
				'u.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('subscription.plan', 'plan')
			.leftJoin(User, 'admin', 'admin.id = u.adminId')
			.addSelect(['admin.id', 'admin.name', 'admin.email'])
			.orderBy('u.id', 'DESC');

		if (tab === 'active') qb.andWhere('u.isActive = true');
		if (tab === 'inactive') qb.andWhere('u.isActive = false');

		if (active === 'true') qb.andWhere('u.isActive = true');
		if (active === 'false') qb.andWhere('u.isActive = false');

		if (adminId) qb.andWhere('u.adminId = :adminId', { adminId: adminId });

		if (search) qb.andWhere('(u.name LIKE :q OR u.email LIKE :q)', { q: `%${search}%` });
		if (roleContains) qb.andWhere('role.name LIKE :r', { r: `%${roleContains}%` });

		const rows = await qb.getRawAndEntities();

		const header = [
			'id',
			'name',
			'email',
			'role',
			'plan',
			'adminId',
			'adminName',
			'adminEmail',
			'isActive',
		];

		const bom = '\uFEFF';
		const lines = rows.entities.map((u, idx) => {
			const raw = rows.raw[idx] || {};
			const vals = [
				u.id,
				u.name ?? '',
				u.email ?? '',
				u.role?.name ?? '',
				u.activeSubscription?.plan?.name ?? '',
				u.adminId ?? '',
				raw.admin_name ?? '',
				raw.admin_email ?? '',
				u.isActive ? 'true' : 'false',
			];
			return vals.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',');
		});

		const csv = bom + header.join(',') + '\n' + lines.join('\n');

		return {
			filename: `users-super-admin-${Date.now()}.csv`,
			csv,
		};
	}

	private ensureAdminOwnership(me: User, target: User) {
		if (this.isSuperAdmin(me)) return;

		console.log(me, target);

		if (me.id === target.id) return;

		if (me.role?.name === SystemRole.ADMIN) {
			if (target.adminId !== me.id) throw new ForbiddenException('Not your user');
			return;
		}

		throw new ForbiddenException('Not allowed');
	}
	async getEmployeeTypesStats(me: User) {
		// Super admin يشوف كل الأنواع
		const qb = this.usersRepo.createQueryBuilder('u');

		if (!this.isSuperAdmin(me)) {
			if (me.role?.name === SystemRole.ADMIN) {
				qb.where('u.adminId = :adminId', { adminId: me.id });
			} else {
				qb.where('u.id = :id', { id: me.id });
			}
		}

		// group by employeeType
		const rows = await qb
			.select('COALESCE(u.employeeType, :unknown)', 'type')
			.addSelect('COUNT(*)', 'count')
			.setParameter('unknown', 'unknown')
			.groupBy('COALESCE(u.employeeType, :unknown)')
			.getRawMany();

		const total = rows.reduce((sum, r) => sum + Number(r.count), 0);

		return {
			total,
			types: [
				{ id: 'all', count: total },
				...rows
					.filter((r) => r.type !== 'unknown')
					.map((r) => ({
						id: r.type,
						count: Number(r.count),
					})),
			],
		};
	}
	async updateMyAvatar(me: User, avatar?: Express.Multer.File) {
		if (!avatar) throw new BadRequestException('Avatar file is required');

		const user = await this.usersRepo.findOne({
			where: { id: me.id }, relations: {
				role: true
			}
		});
		if (!user) throw new BadRequestException('User not found');

		const old = user.avatarUrl;

		user.avatarUrl = `/uploads/avatars/${avatar.filename}`;
		const saved = await this.usersRepo.save(user);
		if (old) {

			try {

				const filePath = join(process.cwd(), old);
				await unlink(filePath);
			} catch (err: any) {
				// Log error but don't stop the process if one file is already missing
				console.error(`Failed to delete file at ${old}:`, err.message);
			}
		}

		return {
			id: saved.id,
			avatarUrl: saved.avatarUrl,
		};
	}
	// ✅ UPDATED: Include plan relation
	async list(me: User, limit: number, cursor: number) {
		const fetchLimit = Number(limit) || 20;
		const qb = this.usersRepo
			.createQueryBuilder("user")
			.leftJoinAndSelect("user.role", "role")
			.leftJoinAndSelect(
				'user.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('subscription.plan', 'plan')
			.orderBy("user.id", "DESC")
			.take(fetchLimit + 1);

		// Apply cursor (id-based)
		if (cursor) {
			qb.andWhere("user.id < :cursor", { cursor: cursor });
		}

		// Access control
		if (this.isSuperAdmin(me)) {
			// no extra filter
		} else if (me.role?.name === SystemRole.ADMIN) {
			qb.andWhere("user.adminId = :adminId", { adminId: me.id });
		} else {
			qb.andWhere("user.id = :id", { id: me.id });
		}
		const rawUsers = await qb.getMany();

		const hasMore = rawUsers.length > fetchLimit;

		if (hasMore) {
			rawUsers.pop(); // Remove the extra (+1) record from the results
		}

		const users = rawUsers.map((user) => {
			const activeSub = user.activeSubscription || null;

			// Destructure to remove the 'subscriptions' array from the final output
			const { subscriptions, ...userData } = user as any;

			return {
				...userData,
				subscription: activeSub,
			};
		});

		const nextCursor = hasMore && users.length > 0
			? users[users.length - 1].id
			: null;

		return {
			data: users,
			nextCursor,
			hasMore,
		};
	}


	async listForTable(
		me: User,
		opts: { page: number; limit: number; search: string; type: string }
	) {
		const page = Math.max(1, Number(opts.page || 1));
		const limit = Math.min(100, Math.max(1, Number(opts.limit || 6)));
		const skip = (page - 1) * limit;

		// const baseWhere: any = {};
		// if (!this.isSuperAdmin(me)) {
		// 	if (me.role?.name !== SystemRole.ADMIN) {
		// 		baseWhere.id = me.id;
		// 	} else {
		// 		baseWhere.adminId = me.id;
		// 	}
		// }

		// Search by name/email/phone
		// TypeORM OR conditions
		const search = (opts.search || '').trim();
		const type = (opts.type || 'all').trim();

		const whereOr: any[] = [];
		const pushSearch = (extra: any) => {
			if (!search) return [extra];
			// LIKE for name/email/phone
			return [
				{ ...extra, name: () => `name LIKE '%${search.replace(/'/g, "''")}%'` },
				{ ...extra, email: () => `email LIKE '%${search.replace(/'/g, "''")}%'` },
				{ ...extra, phone: () => `phone LIKE '%${search.replace(/'/g, "''")}%'` },
			];
		};

		const qb = this.usersRepo
			.createQueryBuilder('u')
			.leftJoinAndSelect('u.role', 'role')
			.leftJoinAndSelect(
				'u.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('subscription.plan', 'plan')
			.orderBy('u.id', 'DESC');

		// ownership
		if (!this.isSuperAdmin(me)) {
			if (me.role?.name === SystemRole.ADMIN) {
				qb.andWhere('u.adminId = :adminId', { adminId: me.id });
			} else {
				qb.andWhere('u.id = :id', { id: me.id });
			}
		}

		// filter by type
		if (type && type !== 'all') {
			qb.andWhere('u.employeeType = :type', { type });
		}

		// search
		if (search) {
			qb.andWhere(
				'(u.name LIKE :q OR u.email LIKE :q OR u.phone LIKE :q)',
				{ q: `%${search}%` }
			);
		}

		// count + pagination
		const total_records = await qb.getCount();
		const records = await qb.skip(skip).take(limit).getMany();

		const qb2 = this.usersRepo.createQueryBuilder('u');

		if (!this.isSuperAdmin(me)) {
			if (me.role?.name === SystemRole.ADMIN) qb2.where('u.adminId = :adminId', { adminId: me.id });
			else qb2.where('u.id = :id', { id: me.id });
		} else {
			qb2.where('1=1');
		}

		if (search) {
			qb2.andWhere('(u.name LIKE :q OR u.email LIKE :q OR u.phone LIKE :q)', { q: `%${search}%` });
		}

		// group by employeeType
		const grouped = await qb2
			.select('COALESCE(u.employeeType, :unknown)', 'employeeType')
			.addSelect('COUNT(*)', 'count')
			.setParameter('unknown', 'unknown')
			.groupBy('COALESCE(u.employeeType, :unknown)')
			.getRawMany();

		const byType: Record<string, number> = {};
		grouped.forEach((g) => {
			byType[g.employeeType] = Number(g.count);
		});

		const totalAll = Object.values(byType).reduce((a, b) => a + b, 0);

		const types = [
			{ id: 'all', label: 'All', count: totalAll },
			...Object.entries(byType)
				.filter(([k]) => k !== 'unknown')
				.map(([k, v]) => ({ id: k, label: k, count: v })),
		];

		return {
			records: records.map((u) => {
				// 1. Extract the active subscription from the array
				const activeSub = u.activeSubscription || null;

				return {
					id: u.id,
					name: u.name,
					email: u.email,
					phone: u.phone,
					employeeType: u.employeeType,

					// 2. Map subscription and plan data
					// We return the subscription object, but specifically the plan info for the FE
					subscription: activeSub ? {
						id: activeSub.id,
						status: activeSub.status,
						planId: activeSub.planId,
						planName: activeSub.plan?.name, // From snapshot
						startDate: activeSub.startDate,
						endDate: activeSub.endDate
					} : null,

					type: u.employeeType, // for frontend logic
					typeLabel: u.employeeType, // for display
					isActive: u.isActive,
				};
			}),
			total_records,
			current_page: page,
			per_page: limit,
			types,
			stats: {
				total: totalAll,
				byType,
			},
		};
	}
	async toggleActive(me: User, id: string) {
		const user = await this.get(me, id);
		this.ensureAdminOwnership(me, user);

		const newStatus = !user.isActive;
		await this.usersRepo.update(id, { isActive: newStatus });

		return { id: user.id, isActive: newStatus };
	}

	async exportCsv(me: User, opts: { search: string; type: string }) {
		const search = (opts.search || '').trim();
		const type = (opts.type || 'all').trim();

		const qb = this.usersRepo
			.createQueryBuilder('u')
			.leftJoinAndSelect('u.role', 'role')
			.orderBy('u.id', 'DESC');

		if (!this.isSuperAdmin(me)) {
			if (me.role?.name === SystemRole.ADMIN) qb.where('u.adminId = :adminId', { adminId: me.id });
			else qb.where('u.id = :id', { id: me.id });
		}

		if (type !== 'all') qb.andWhere('u.employeeType = :type', { type });

		if (search) {
			qb.andWhere('(u.name LIKE :q OR u.email LIKE :q OR u.phone LIKE :q)', { q: `%${search}%` });
		}

		const users = await qb.getMany();

		const header = ['id', 'name', 'email', 'phone', 'employeeType', 'isActive'];
		const rows = users.map((u) => [
			u.id,
			(u.name || '').replaceAll('"', '""'),
			(u.email || '').replaceAll('"', '""'),
			(u.phone || '').replaceAll('"', '""'),
			(u.employeeType || '').replaceAll('"', '""'),
			u.isActive ? 'true' : 'false',
		]);

		// UTF-8 BOM for Excel arabic
		const bom = '\uFEFF';
		const csv =
			bom +
			header.join(',') +
			'\n' +
			rows.map((r) => r.map((x) => `"${x}"`).join(',')).join('\n');

		return {
			filename: `users-${Date.now()}.csv`,
			csv,
		};
	}

	async remove(me: User, id: string) {
		const user = await this.get(me, id);
		this.ensureAdminOwnership(me, user);

		// امنع حذف سوبر ادمن
		if (!this.isSuperAdmin(me) && user.role?.name === SystemRole.SUPER_ADMIN) {
			throw new ForbiddenException('Cannot delete super admin');
		}

		await this.usersRepo.delete({ id: user.id });
		return { ok: true };
	}


	// ✅ UPDATED: Include plan relation
	async get(me: User, id: string) {
		const user = await this.getFullUser(id)

		if (!user) throw new NotFoundException('User not found');

		if (!this.isSuperAdmin(me) && me.role?.name === SystemRole.ADMIN) {
			this.ensureAdminOwnership(me, user);
			return user;
		}

		if (me.role?.name === SystemRole.USER && me.id !== id) {
			throw new ForbiddenException('Not allowed');
		}

		return user;
	}
	async getMe(id: string) {
		const user = await this.getFullUser(id)

		if (!user) throw new NotFoundException('User not found');

		return user;
	}

	private generatePassword(len = 10) {
		return crypto.randomBytes(32).toString('base64url').slice(0, len);
	}

	// ✅ UPDATED: Handle planId
	async adminCreate(me: User, dto: AdminCreateDto) {
		if (!(this.isSuperAdmin(me) || me.role?.name === SystemRole.ADMIN)) {
			throw new ForbiddenException('Not allowed');
		}

		const exists = await this.usersRepo.findOne({ where: { email: dto.roleId } });
		if (exists) throw new BadRequestException('Email already used');

		const role = await this.rolesRepo.findOne({ where: { id: dto.roleId } });
		if (!role) throw new BadRequestException('Role not found');

		if (!this.isSuperAdmin(me) && role.name === SystemRole.SUPER_ADMIN) {
			throw new ForbiddenException('Admin cannot create super admin');
		}

		// ✅ NEW: Validate plan if provided

		const plainPassword = dto.password || this.generatePassword(10);
		const passwordHash = await bcrypt.hash(plainPassword, 10);

		const user = this.usersRepo.create({
			name: dto.name,
			email: dto.email,
			passwordHash,
			roleId: dto.roleId,
			adminId: this.isSuperAdmin(me) ? null : me.id,
			isActive: true,
		});

		const saved = await this.usersRepo.save(user);
		const fullUser = await this.getFullUser(saved.id)
		// ✅ UPDATED: Include plan relation

		return {
			user: fullUser,
			credentials: {
				email: saved.email,
				password: plainPassword,
			},
		};
	}


	private async ensureUsersLimit(me: User) {
		if (this.isSuperAdmin(me)) return;
		if (me.role?.name !== SystemRole.ADMIN) return;

		const subscription =
			await this.subscriptionsService.getMyActiveSubscription(me);

		const currentCount = await this.usersRepo.count({
			where: { adminId: me.id },
		});

		if (subscription?.usersLimit != null && currentCount >= subscription?.usersLimit) {
			throw new BadRequestException('Users limit reached');
		}
	}



	async adminCreateAvatar(
		me: User,
		name: string,
		email: string,
		roleId: string,
		password?: string,
		phone?: string,        // ✅ NEW
		employeeType?: string, // ✅ NEW
		avatar?: Express.Multer.File, // ✅ NEW
	) {
		if (!(this.isSuperAdmin(me) || me.role?.name === SystemRole.ADMIN)) {
			throw new ForbiddenException('Not allowed');
		}

		await this.ensureUsersLimit(me);

		const exists = await this.usersRepo.findOne({ where: { email } });
		if (exists) throw new BadRequestException('Email already used');

		const role = await this.rolesRepo.findOne({ where: { id: roleId } });
		if (!role) throw new BadRequestException('Role not found');

		if (!this.isSuperAdmin(me) && role.name === SystemRole.SUPER_ADMIN) {
			throw new ForbiddenException('Admin cannot create super admin');
		}

		if (!this.isSuperAdmin(me) && role.name === SystemRole.ADMIN) {
			// If the logged-in user is only ADMIN, they cannot create another ADMIN
			throw new ForbiddenException('Admin cannot create admin');
		}


		const plainPassword = password || this.generatePassword(10);
		const passwordHash = await bcrypt.hash(plainPassword, 10);


		let avatarUrl = null;
		if (avatar) {
			avatarUrl = `/uploads/avatars/${avatar.filename}`;
		}

		const user = this.usersRepo.create({
			name,
			email,
			passwordHash,
			roleId,
			phone: phone || null,
			employeeType: employeeType || null,
			avatarUrl: avatarUrl,
			adminId: me.id,
			isActive: true,
		});

		const saved = await this.usersRepo.save(user);

		const fullUser = await this.getFullUser(saved.id)

		return {
			user: fullUser,
			credentials: {
				email: saved.email,
				password: plainPassword,
			},
		};

	}

	// ✅ UPDATED: Handle planId in updates
	async update(me: User, id: string, patch: UpdateUserDto) {
		const user = await this.get(me, id);

		if (!this.isSuperAdmin(me) && user.role?.name === SystemRole.SUPER_ADMIN) {
			throw new ForbiddenException('Cannot edit super admin');
		}

		if (patch.email && patch.email !== user.email) {
			const exists = await this.usersRepo.findOne({ where: { email: patch.email } });
			if (exists) throw new BadRequestException('Email already used');
		}

		if (patch.roleId) {
			const role = await this.rolesRepo.findOne({ where: { id: patch.roleId } });
			if (!role) throw new BadRequestException('Role not found');

			if (!this.isSuperAdmin(me) && role.name === SystemRole.SUPER_ADMIN) {
				throw new ForbiddenException('Admin cannot assign super admin');
			}

			user.roleId = patch.roleId;
		}

		if (typeof patch.name === 'string') user.name = patch.name;
		if (typeof patch.email === 'string') user.email = patch.email;
		if (typeof patch.isActive === 'boolean') user.isActive = patch.isActive;
		if (typeof (patch as any).phone === 'string') user.phone = (patch as any).phone;
		if (typeof (patch as any).employeeType === 'string') user.employeeType = (patch as any).employeeType;

		const saved = await this.usersRepo.save(user);

		// ✅ Return with plan relation
		return await this.getFullUser(saved.id)
	}
	async updateMe(me: User, patch: UpdateMeUserDto) {
		const user = await this.get(me, me.id);


		if (typeof patch.name === 'string') user.name = patch.name;
		if (typeof patch.isActive === 'boolean') user.isActive = patch.isActive;
		if (typeof (patch as any).phone === 'string') user.phone = patch.phone;

		const saved = await this.usersRepo.save(user);
		// ✅ Return with plan relation
		return await this.getFullUser(saved.id)
	}

	async deactivate(me: User, id: string) {
		const user = await this.get(me, id);
		user.isActive = false;
		return this.usersRepo.save(user);
	}

	async adminResetPassword(me: User, id: string, newPassword?: string) {
		const user = await this.get(me, id);
		this.ensureAdminOwnership(me, user);

		const plain = newPassword || this.generatePassword(10);
		user.passwordHash = await bcrypt.hash(plain, 10);
		await this.usersRepo.save(user);

		return {
			userId: user.id,
			email: user.email,
			password: plain,
		};
	}

	async processNextOnboardingStep(userId: string, me: any) {
		if (me.role?.name !== 'admin') {
			throw new ForbiddenException('Only admins can complete onboarding');
		}

		const user = await this.usersRepo.createQueryBuilder('user')
			// Join Role
			.leftJoinAndSelect('user.role', 'role')
			.leftJoinAndSelect('user.company', 'company')

			// Join only the ACTIVE subscription
			.leftJoinAndSelect(
				'user.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)

			// Join the Plan details for that active subscription
			.leftJoinAndSelect('subscription.plan', 'plan')

			.where('user.id = :userId', { userId })
			.getOne();


		if (!user) throw new NotFoundException('User not found');

		if (user.role.name !== 'admin') {
			throw new ForbiddenException('Only admins can complete onboarding');
		}

		let nextStep: OnboardingStep;

		switch (user.currentOnboardingStep) {
			case OnboardingStep.WELCOME:
				nextStep = OnboardingStep.PLAN;
				break;

			case OnboardingStep.PLAN:
				// Requirement: Must have a subscription/plan
				if (!user.activeSubscription) {
					throw new BadRequestException('Please select a plan to continue.');
				}
				nextStep = OnboardingStep.COMPANY;
				break;

			case OnboardingStep.COMPANY:
				// Requirement: Must have company details saved
				if (!user.company) {
					throw new BadRequestException('Please complete your company profile.');
				}
				nextStep = OnboardingStep.STORE;
				break;

			case OnboardingStep.STORE:
				nextStep = OnboardingStep.SHIPPING;
				break;

			case OnboardingStep.SHIPPING:
				nextStep = OnboardingStep.FINISHED;
				user.onboardingStatus = OnboardingStatus.COMPLETED;
				break;

			default:
				return { message: 'Onboarding already completed', step: user.currentOnboardingStep };
		}

		user.currentOnboardingStep = nextStep;
		await this.usersRepo.save(user);

		return { nextStep };
	}

	// users.service.ts
	async upsertCompany(me: User, dto: UpsertCompanyDto) {
		if (me.role?.name !== 'admin') {
			throw new ForbiddenException('Only admins can update company informations');
		}

		return await this.dataSource.transaction(async (manager) => {
			// Fetch user with existing company relation
			const user = await manager.findOne(User, {
				where: { id: me.id },
				relations: ['company'],
			});

			if (!user) throw new NotFoundException('User not found');

			let company = user.company;

			if (company) {
				// Update existing
				manager.merge(Company, company, dto);
			} else {
				// Create new
				company = manager.create(Company, {
					...dto,
					user: user,
				});
			}

			const savedCompany = await manager.save(company);

			return savedCompany;
		});
	}

	async getCompany(me: User) {
		const adminId = tenantId(me);
		const user = await this.usersRepo.findOne({
			where: { id: adminId },
			relations: ['company'],
		});

		if (!user) throw new NotFoundException('User not found');

		return user.company || null;
	}

	async getCompanyCurrency(me: User, manager?: EntityManager): Promise<string> {
		const repo = manager ? manager.getRepository(User) : this.usersRepo;
		const adminId = tenantId(me);
		const user = await repo.findOne({
			where: { id: adminId },
			relations: ['company'],
		});

		if (!user || !user.company) {
			return 'EGP';
		}

		return user.company.currency || 'EGP';
	}
}