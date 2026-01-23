import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Permission, Role, SystemRole, User } from 'entities/user.entity';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { CreateRoleDto, UpdateRoleDto } from 'dto/role.dto';

@Injectable()
export class RolesService implements OnModuleInit {
	constructor(
		@InjectRepository(Role) private rolesRepo: Repository<Role>,
		@InjectRepository(Permission) private permsRepo: Repository<Permission>,
		@InjectRepository(User) private usersRepo: Repository<User>,
		private dataSource: DataSource,
	) { }

	async onModuleInit() {
		await this.seedPermissions();
		await this.seedPredefinedRoles();
	}

	// ✅ Seed Permissions
	private async seedPermissions() {
		const permissions = [
			{ name: 'users.read', description: 'View users' },
			{ name: 'users.create', description: 'Create users' },
			{ name: 'users.create_admin', description: 'Admin create user with credentials' },
			{ name: 'users.update', description: 'Update users' },
			{ name: 'users.deactivate', description: 'Deactivate users' },
			{ name: 'users.view_credentials', description: 'View user credentials' },
			{ name: 'roles.read', description: 'View roles' },
			{ name: 'roles.create', description: 'Create roles' },
			{ name: 'roles.update', description: 'Update roles' },
			{ name: 'roles.delete', description: 'Delete roles' },
			{ name: 'permissions.read', description: 'View permissions' },
		];

		for (const p of permissions) {
			const exists = await this.permsRepo.findOne({ where: { name: p.name } });
			if (!exists) {
				await this.permsRepo.save(this.permsRepo.create(p));
			}
		}
	}

	// ✅ Seed Global Roles
	private async seedPredefinedRoles() {
		const predefined: Array<{
			name: string;
			description: string;
			permissionNames: string[];
		}> = [
				{
					name: SystemRole.SUPER_ADMIN,
					description: 'Owner of the system (full access)',
					permissionNames: ['*'],
				},
				{
					name: SystemRole.ADMIN,
					description: 'Admin (manages his own users and roles)',
					permissionNames: [
						'users.read',
						'users.create',
						'users.create_admin',
						'users.update',
						'users.deactivate',
						'users.view_credentials',
						'roles.read',
						'roles.create',
						'roles.update',
						'roles.delete',
						'permissions.read',
					],
				},
				{
					name: SystemRole.USER,
					description: 'Regular user',
					permissionNames: [],
				},
			];

		for (const r of predefined) {
			const exists = await this.rolesRepo.findOne({ where: { name: r.name } });
			if (!exists) {
				await this.rolesRepo.save(
					this.rolesRepo.create({
						name: r.name,
						description: r.description,
						permissionNames: r.permissionNames,
						adminId: null, // Global roles
						isGlobal: true,
					}),
				);
			}
		}
	}

	// ✅ Check if user is super admin
	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
	}



	// ✅ Get Single Role
	// async get(me: User, id: number) {
	// 	const role = await this.rolesRepo.findOne({ where: { id } });
	// 	if (!role) throw new NotFoundException('Role not found');

	// 	// Super admin can see all
	// 	if (this.isSuperAdmin(me)) return role;

	// 	// Admin can see global + his own
	// 	if (me.role?.name === SystemRole.ADMIN) {
	// 		if (role.isGlobal || role.adminId === me.id) return role;
	// 		throw new ForbiddenException('Not your role');
	// 	}

	// 	// Normal user can only see global
	// 	if (role.isGlobal) return role;
	// 	throw new ForbiddenException('Not allowed');
	// }

	async get(me: User, id: number) {
		const role = await this.rolesRepo.findOne({ where: { id } });
		if (!role) throw new NotFoundException('Role not found');

		// Super admin: only roles with adminId null
		if (this.isSuperAdmin(me)) {
			if (role.adminId === null) return role;
			throw new ForbiddenException('Not allowed');
		}

		// block viewing super_admin/admin roles for everyone else
		if ([SystemRole.SUPER_ADMIN, SystemRole.ADMIN].includes(role.name as any)) {
			throw new ForbiddenException('Not allowed');
		}

		// Admin: global or owned by him
		if (me.role?.name === SystemRole.ADMIN) {
			if (role.adminId === null || role.adminId === me.id) return role;
			throw new ForbiddenException('Not your role');
		}

		// Other roles: global or owned by his owner adminId
		if (role.adminId === null) return role;

		if (me.adminId && role.adminId === me.adminId) return role;

		throw new ForbiddenException('Not allowed');
	}


	async list(me: User) {
		const qb = this.rolesRepo.createQueryBuilder('r')
			.orderBy('r.id', 'DESC');

		if (this.isSuperAdmin(me)) {
			qb.where('r.adminId IS NULL');
			return qb.getMany();
		}

		// everyone except super admin: block super_admin/admin
		qb.andWhere('r.name NOT IN (:...blocked)', {
			blocked: [SystemRole.SUPER_ADMIN, SystemRole.ADMIN],
		});

		if (me.role?.name === SystemRole.ADMIN) {
			qb.andWhere('(r.adminId IS NULL OR r.adminId = :meId)', { meId: me.id });
			return qb.getMany();
		}

		if (me.adminId) {
			qb.andWhere('(r.adminId IS NULL OR r.adminId = :ownerAdminId)', { ownerAdminId: me.adminId });
			return qb.getMany();
		}

		qb.andWhere('r.adminId IS NULL');
		return qb.getMany();
	}


	// ✅ Create Role
	async create(me: User, dto: CreateRoleDto) {

		if (!(this.isSuperAdmin(me) || me.role?.name === SystemRole.ADMIN)) {
			throw new ForbiddenException('Not allowed');
		}

		const exists = await this.rolesRepo.findOne({ where: { name: dto.name } });
		if (exists) throw new BadRequestException('Role name already exists');

		const role = this.rolesRepo.create({
			name: dto.name,
			description: dto.description,
			permissionNames: dto.permissionNames || [],
			adminId: dto?.adminId ? dto?.adminId : null,
			isGlobal: dto?.global,
		});

		return this.rolesRepo.save(role);
	}

	// ✅ Update Role
	async update(me: User, id: number, dto: UpdateRoleDto) {
		const role = await this.get(me, id);

		// Can't edit global roles unless super admin
		if (role.isGlobal && !this.isSuperAdmin(me)) {
			throw new ForbiddenException('Cannot edit global roles');
		}

		// Admin can only edit his own roles
		if (!this.isSuperAdmin(me) && role.adminId !== me.id) {
			throw new ForbiddenException('Not your role');
		}

		if (dto.name && dto.name !== role.name) {
			const exists = await this.rolesRepo.findOne({ where: { name: dto.name } });
			if (exists) throw new BadRequestException('Role name already exists');
			role.name = dto.name;
		}

		if (dto.description !== undefined) role.description = dto.description;
		if (dto.permissionNames) role.permissionNames = dto.permissionNames;

		return this.rolesRepo.save(role);
	}

	// ✅ Delete Role
	async remove(me: User, id: number) {
		const role = await this.get(me, id);


		// ✅ Admin يقدر يحذف بس roles بتاعته
		if (!this.isSuperAdmin(me) && role.adminId !== me.id) {
			throw new ForbiddenException('Not your role');
		}

		return this.dataSource.transaction(async (manager) => {
			const rolesRepo = manager.getRepository(Role);
			const usersRepo = manager.getRepository(User);

			// ✅ هات كل المستخدمين اللي عليهم roleId = role.id
			const users = await usersRepo.find({
				where: { roleId: role.id },
				select: ['id', 'roleId'],
			});

			if (users.length > 0) {
				// ✅ اعمل/هات default role (بدون permissions) لنفس adminId بتاع الدور المحذوف
				const defaultName = `default_${role.adminId}`; // unique per admin

				let defaultRole = await rolesRepo.findOne({
					where: { name: defaultName, adminId: role.adminId },
				});

				if (!defaultRole) {
					defaultRole = await rolesRepo.save(
						rolesRepo.create({
							name: defaultName,
							description: 'Default role (auto-created)',
							permissionNames: [],
							adminId: role.adminId,
							// لو عندك isGlobal خليه false
							// isGlobal: false,
						}),
					);
				}

				// ✅ انقل كل المستخدمين للـ defaultRole
				await usersRepo
					.createQueryBuilder()
					.update(User)
					.set({ roleId: defaultRole.id })
					.where('roleId = :oldRoleId', { oldRoleId: role.id })
					.execute();
			}

			// ✅ احذف الدور القديم
			await rolesRepo.delete(role.id);

			return {
				message: 'Role deleted',
				reassignedUsers: users.length,
			};
		});
	}


	// ✅ Get All Permissions (for dropdown)
	async getPermissions() {
		return this.permsRepo.find({ order: { name: 'ASC' } });
	}
}