import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';
import { PermissionsGuard } from 'common/permissions.guard';
import { CreateRoleDto, UpdateRoleDto } from 'dto/role.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('roles')
export class RolesController {
	constructor(private roles: RolesService) { }

	@Permissions('roles.read')
	@Get()
	list(@Req() req: any) {
		return this.roles.list(req.user);
	}

	@Permissions('roles.read')
	@Get('permissions')
	getPermissions() {
		return this.roles.getPermissions();
	}

	@Permissions('roles.read')
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.roles.get(req.user, Number(id));
	}

	@Permissions('roles.create')
	@Post()
	create(@Req() req: any, @Body() dto: CreateRoleDto) {
		return this.roles.create(req.user, dto);
	}

	@Permissions('roles.update')
	@Patch(':id')
	update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
		return this.roles.update(req.user, Number(id), dto);
	}

	@Permissions('roles.delete')
	@Delete(':id')
	remove(@Req() req: any, @Param('id') id: string) {
		return this.roles.remove(req.user, Number(id));
	}
}