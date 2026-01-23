import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role, SystemRole, User } from 'entities/user.entity';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Plan } from 'entities/plans.entity';

@Injectable()
export class UsersService {
	constructor(
		@InjectRepository(User) private usersRepo: Repository<User>,
		@InjectRepository(Role) private rolesRepo: Repository<Role>,
		@InjectRepository(Plan) private plansRepo: Repository<Plan>, // ✅ NEW
	) { }

	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
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
			.leftJoinAndSelect('u.plan', 'plan')
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
		if (adminId) qb.andWhere('u.adminId = :adminId', { adminId: Number(adminId) });

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
			return {
				id: u.id,
				name: u.name,
				email: u.email,
				isActive: u.isActive,
				adminId: u.adminId ?? null,

				// extra info
				role: u.role ? { id: u.role.id, name: u.role.name } : null,
				plan: u.plan ? { id: u.plan.id, name: u.plan.name } : null,

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
		if (adminId) qbStats.andWhere('u.adminId = :adminId', { adminId: Number(adminId) });
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
			.leftJoinAndSelect('u.plan', 'plan')
			.leftJoin(User, 'admin', 'admin.id = u.adminId')
			.addSelect(['admin.id', 'admin.name', 'admin.email'])
			.orderBy('u.id', 'DESC');

		if (tab === 'active') qb.andWhere('u.isActive = true');
		if (tab === 'inactive') qb.andWhere('u.isActive = false');

		if (active === 'true') qb.andWhere('u.isActive = true');
		if (active === 'false') qb.andWhere('u.isActive = false');

		if (adminId) qb.andWhere('u.adminId = :adminId', { adminId: Number(adminId) });

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
				u.plan?.name ?? '',
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

		const user = await this.usersRepo.findOne({ where: { id: me.id }, relations: { role: true, plan: true } });
		if (!user) throw new BadRequestException('User not found');

		user.avatarUrl = `/uploads/avatars/${avatar.filename}`;
		const saved = await this.usersRepo.save(user);

		return {
			id: saved.id,
			avatarUrl: saved.avatarUrl,
		};
	}
	// ✅ UPDATED: Include plan relation
	async list(me: User) {
		const relations = { role: true, plan: true }; // ✅ Include plan

		if (this.isSuperAdmin(me)) {
			return this.usersRepo.find({
				order: { id: 'DESC' },
				relations,
			});
		}

		if (me.role?.name === SystemRole.ADMIN) {
			return this.usersRepo.find({
				where: { adminId: me.id },
				order: { id: 'DESC' },
				relations,
			});
		}

		return this.usersRepo.find({
			where: { id: me.id },
			relations,
		});
	}

	async listForTable(
		me: User,
		opts: { page: number; limit: number; search: string; type: string }
	) {
		const page = Math.max(1, Number(opts.page || 1));
		const limit = Math.min(100, Math.max(1, Number(opts.limit || 6)));
		const skip = (page - 1) * limit;

		const baseWhere: any = {};
		if (!this.isSuperAdmin(me)) {
			if (me.role?.name !== SystemRole.ADMIN) {
				baseWhere.id = me.id;
			} else {
				baseWhere.adminId = me.id;
			}
		}

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
			.leftJoinAndSelect('u.plan', 'plan')
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
			records: records.map((u) => ({
				id: u.id,
				name: u.name,
				email: u.email,
				phone: u.phone,
				employeeType: u.employeeType,
				type: u.employeeType, // للـ frontend
				typeLabel: u.employeeType, // لو عندك mapping ترجمة اعمله في FE
				isActive: u.isActive,
			})),
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
	async toggleActive(me: User, id: number) {
		const user = await this.get(me, id);
		this.ensureAdminOwnership(me, user);

		user.isActive = !user.isActive;
		const saved = await this.usersRepo.save(user);

		return { id: saved.id, isActive: saved.isActive };
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

	async remove(me: User, id: number) {
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
	async get(me: User, id: number) {
		const user = await this.usersRepo.findOne({
			where: { id },
			relations: { role: true, plan: true }, // ✅ Include plan
		});

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
	async getMe(id: number) {
		const user = await this.usersRepo.findOne({
			where: { id },
			relations: { role: true, plan: true }, // ✅ Include plan
		});

		if (!user) throw new NotFoundException('User not found');

		return user;
	}

	private generatePassword(len = 10) {
		return crypto.randomBytes(32).toString('base64url').slice(0, len);
	}

	// ✅ UPDATED: Handle planId
	async adminCreate(
		me: User,
		name: string,
		email: string,
		roleId: number,
		password?: string,
		planId?: number, // ✅ NEW parameter
	) {
		if (!(this.isSuperAdmin(me) || me.role?.name === SystemRole.ADMIN)) {
			throw new ForbiddenException('Not allowed');
		}

		const exists = await this.usersRepo.findOne({ where: { email } });
		if (exists) throw new BadRequestException('Email already used');

		const role = await this.rolesRepo.findOne({ where: { id: roleId } });
		if (!role) throw new BadRequestException('Role not found');

		if (!this.isSuperAdmin(me) && role.name === SystemRole.SUPER_ADMIN) {
			throw new ForbiddenException('Admin cannot create super admin');
		}

		// ✅ NEW: Validate plan if provided
		let plan = null;
		if (planId) {
			plan = await this.plansRepo.findOne({ where: { id: planId } });
			if (!plan) {
				throw new BadRequestException('Plan not found');
			}

			// Check if plan is active
			if (!plan.isActive) {
				throw new BadRequestException('Selected plan is not active');
			}
		}

		const plainPassword = password || this.generatePassword(10);
		const passwordHash = await bcrypt.hash(plainPassword, 10);

		const user = this.usersRepo.create({
			name,
			email,
			passwordHash,
			roleId,
			planId: planId || null, // ✅ NEW: Assign plan
			adminId: this.isSuperAdmin(me) ? null : me.id,
			isActive: true,
		});

		const saved = await this.usersRepo.save(user);

		// ✅ UPDATED: Include plan relation
		const fullUser = await this.usersRepo.findOneOrFail({
			where: { id: saved.id },
			relations: { role: true, plan: true },
		});

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

		if (!me.planId) {
			throw new BadRequestException('No plan assigned to this admin');
		}

		const plan = await this.plansRepo.findOne({ where: { id: me.planId } });
		if (!plan) throw new BadRequestException('Plan not found');
		if (!plan.isActive) throw new BadRequestException('Your plan is not active');

		const currentCount = await this.usersRepo.count({
			where: { adminId: me.id },
		});

		if (currentCount >= plan.usersLimit) {
			throw new BadRequestException('Users limit reached');
		}
	}


	async adminCreateAvatar(
		me: User,
		name: string,
		email: string,
		roleId: number,
		password?: string,
		planId?: number,
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

		// ✅ NEW: Validate plan if provided
		let plan = null;
		if (planId) {
			plan = await this.plansRepo.findOne({ where: { id: planId } });
			if (!plan) {
				throw new BadRequestException('Plan not found');
			}

			// Check if plan is active
			if (!plan.isActive) {
				throw new BadRequestException('Selected plan is not active');
			}
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
			planId: planId || null,
			phone: phone || null,
			employeeType: employeeType || null,
			avatarUrl: avatarUrl,
			adminId: me.id,
			isActive: true,
		});

		const saved = await this.usersRepo.save(user);

		const fullUser = await this.usersRepo.findOneOrFail({
			where: { id: saved.id },
			relations: { role: true, plan: true },
		});

		return {
			user: fullUser,
			credentials: {
				email: saved.email,
				password: plainPassword,
			},
		};

	}

	// ✅ UPDATED: Handle planId in updates
	async update(me: User, id: number, patch: Partial<User>) {
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

		if (patch.planId === null) {
			user.planId = null;
		} else if (patch.planId !== undefined) {
			const plan = await this.plansRepo.findOne({ where: { id: patch.planId } });
			if (!plan) throw new BadRequestException("Plan not found");
			if (!plan.isActive) throw new BadRequestException("Selected plan is not active");
			user.planId = patch.planId;
			user.plan = plan
		}

		if (typeof patch.name === 'string') user.name = patch.name;
		if (typeof patch.email === 'string') user.email = patch.email;
		if (typeof patch.isActive === 'boolean') user.isActive = patch.isActive;
		if (typeof (patch as any).phone === 'string') user.phone = (patch as any).phone;
		if (typeof (patch as any).employeeType === 'string') user.employeeType = (patch as any).employeeType;

		const saved = await this.usersRepo.save(user);

		// ✅ Return with plan relation
		return this.usersRepo.findOne({
			where: { id: saved.id },
			relations: { role: true, plan: true },
		});
	}

	async deactivate(me: User, id: number) {
		const user = await this.get(me, id);
		user.isActive = false;
		return this.usersRepo.save(user);
	}

	async adminResetPassword(me: User, id: number, newPassword?: string) {
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
}