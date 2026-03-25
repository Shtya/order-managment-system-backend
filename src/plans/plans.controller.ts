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
import { PlansService } from './plans.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';
import { PermissionsGuard } from 'common/permissions.guard';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';
import { CreatePlanDto, UpdatePlanDto } from 'dto/plans.dto';


@Controller('plans')
export class PlansController {
	constructor(private plans: PlansService) { }

	// ✅ List all plans (filtered by user role)

	@Get()
	list(@Req() req: any) {
		return this.plans.list(req.user);
	}

	// ✅ Get available plans (public for users to subscribe)
	@Get('available')
	@UseGuards(JwtAuthGuard, PermissionsGuard)
	getAvailable() {
		return this.plans.getAvailablePlans();
	}

	// ✅ Get plan statistics (admin only)
	@Permissions('plans.read')
	@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
	@Get('statistics')
	getStatistics(@Req() req: any) {
		return this.plans.getStatistics(req.user);
	}

	// ✅ Get single plan
	@Permissions('plans.read')
	@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.plans.get(req.user, Number(id));
	}

	// ✅ Create plan (admin only)
	@UseGuards(JwtAuthGuard)
	@Post()
	create(@Req() req: any, @Body() dto: CreatePlanDto) {
		return this.plans.create(req.user, dto);
	}

	// ✅ Update plan (admin only)
	@UseGuards(JwtAuthGuard)
	@Patch(':id')
	update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePlanDto) {
		return this.plans.update(req.user, Number(id), dto);
	}

	// ✅ Delete plan (admin only)
	@UseGuards(JwtAuthGuard)
	@Delete(':id')
	remove(@Req() req: any, @Param('id') id: string) {
		return this.plans.remove(req.user, Number(id));
	}
}