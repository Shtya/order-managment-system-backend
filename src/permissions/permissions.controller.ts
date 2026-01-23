import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { CreatePermissionDto } from 'dto/permission.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('permissions')
export class PermissionsController {
	constructor(private perms: PermissionsService) { }

	@Permissions('permissions.read')
	@Get()
	list() {
		return this.perms.list();
	}

	@Permissions('permissions.create')
	@Post()
	create(@Body() dto: CreatePermissionDto) {
		return this.perms.create(dto);
	}

	@Permissions('permissions.delete')
	@Delete(':id')
	remove(@Param('id') id: string) {
		return this.perms.remove(Number(id));
	}
}
