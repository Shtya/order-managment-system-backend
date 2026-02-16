import { Body, Controller, Get, Param, Patch, Post, UseGuards, Req, UseInterceptors, Query, Res, Delete } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { UpdateUserDto } from 'dto/user.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadedFile } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname } from 'path';


const storage = diskStorage({
	destination: './uploads/avatars',
	filename: (req, file, cb) => {
		const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
		cb(null, `avatar-${uniqueSuffix}${extname(file.originalname)}`);
	},
});

const meAvatarStorage = diskStorage({
	destination: './uploads/avatars',
	filename: (req, file, cb) => {
		const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
		cb(null, `avatar-${uniqueSuffix}${extname(file.originalname)}`);
	},
});


@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
	constructor(private users: UsersService) { }

	@Permissions('users.read')
	@Get('stats/types')
	getEmployeeTypesStats(@Req() req: any) {
		return this.users.getEmployeeTypesStats(req.user);
	}

	@Permissions('users.read')
	@Get('super-admin/list')
	superAdminList(
		@Req() req: any,
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('tab') tab?: string,        // all | active | inactive
		@Query('search') search?: string,  // name/email
		@Query('role') role?: string,      // contains
		@Query('active') active?: string,  // all | true | false
		@Query('adminId') adminId?: string // filter by owner
	) {
		return this.users.superAdminList(req.user, {
			page: Number(page ?? 1),
			limit: Number(limit ?? 10),
			tab: tab ?? 'all',
			search: search ?? '',
			role: role ?? '',
			active: active ?? 'all',
			adminId: adminId ?? '',
		});
	}


	@Permissions('users.read')
	@Get('super-admin/export/csv')
	async superAdminExportCsv(
		@Req() req: any,
		@Res() res: any,
		@Query('tab') tab?: string,
		@Query('search') search?: string,
		@Query('role') role?: string,
		@Query('active') active?: string,
		@Query('adminId') adminId?: string,
	) {
		const { filename, csv } = await this.users.superAdminExportCsv(req.user, {
			tab: tab ?? 'all',
			search: search ?? '',
			role: role ?? '',
			active: active ?? 'all',
			adminId: adminId ?? '',
		});

		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		return res.send(csv);
	}


	@Permissions('users.read')
	@Get()
	listForTable(
		@Req() req: any,
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('search') search?: string,
		@Query('type') type?: string,
	) {
		return this.users.listForTable(req.user, {
			page: Number(page ?? 1),
			limit: Number(limit ?? 6),
			search: search ?? '',
			type: type ?? 'all',
		});
	}

	@Permissions('users.read')
	@Get("list")
	list(
		@Req() req: any,
		@Query('cursor') cursor?: string,
		@Query('limit') limit?: string,
	) {
		return this.users.list(req.user, Number(limit ?? 10), cursor ? Number(cursor) : null);
	}



	@Permissions('users.read')
	@Get('export/csv')
	async exportCsv(
		@Req() req: any,
		@Res() res: any,
		@Query('search') search?: string,
		@Query('type') type?: string,
	) {
		const { filename, csv } = await this.users.exportCsv(req.user, {
			search: search ?? '',
			type: type ?? 'all',
		});

		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		return res.send(csv);
	}



	@Permissions('users.read')
	@Get('me')
	getMe(@Req() req: any) {
		return this.users.getMe(req.user?.id);
	}


	@Permissions('users.read')
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.users.get(req.user, Number(id));
	}

	// ✅ Admin creates account and can see credentials
	@Permissions('users.create_admin')
	@Post('admin-create')
	adminCreate(@Req() req: any, @Body() dto: any) {
		return this.users.adminCreate(
			req.user,
			dto.name,
			dto.email,
			dto.roleId,
			dto.password,
			dto.planId, // ✅ NEW
		);
	}


	@Permissions('users.create_admin')
	@Post('admin-create-avatar')
	@UseInterceptors(FileInterceptor('avatar', { storage }))
	async adminCreateAvatar(
		@Req() req: any,
		@Body() dto: any,
		@UploadedFile() avatar?: Express.Multer.File,
	) {
		return this.users.adminCreateAvatar(
			req.user,
			dto.name,
			dto.email,
			dto.roleId,
			dto.password,
			dto.planId,
			dto.phone,
			dto.employeeType,
			avatar,
		);
	}


	@Permissions('users.update')
	@Patch('me')
	updateMe(@Req() req: any, @Body() dto: UpdateUserDto) {
		return this.users.update(req.user, Number(req.user.id), dto as any);
	}

	@Permissions('users.update')
	@Post('me/avatar')
	@UseInterceptors(FileInterceptor('avatar', { storage: meAvatarStorage }))
	async updateMyAvatar(
		@Req() req: any,
		@UploadedFile() avatar?: Express.Multer.File,
	) {
		return this.users.updateMyAvatar(req.user, avatar);
	}


	@Permissions('users.update') // أو اعمل permission جديدة users.toggle_active
	@Patch(':id/toggle-active')
	toggleActive(@Req() req: any, @Param('id') id: string) {
		return this.users.toggleActive(req.user, Number(id));
	}



	@Permissions('users.update')
	@Patch(':id')
	update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateUserDto) {
		return this.users.update(req.user, Number(id), dto as any);
	}

	@Permissions('users.deactivate')
	@Post(':id/deactivate')
	deactivate(@Req() req: any, @Param('id') id: string) {
		return this.users.deactivate(req.user, Number(id));
	}

	// ✅ Admin reset password for his user and view it
	@Permissions('users.view_credentials')
	@Post(':id/reset-password')
	resetPassword(@Req() req: any, @Param('id') id: string, @Body() body: { newPassword?: string }) {
		return this.users.adminResetPassword(req.user, Number(id), body?.newPassword);
	}


	@Permissions('users.delete') // أو users.delete
	@Delete(':id')
	remove(@Req() req: any, @Param('id') id: string) {
		return this.users.remove(req.user, Number(id));
	}

}
