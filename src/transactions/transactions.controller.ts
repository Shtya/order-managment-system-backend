import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Req,
	UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';
import { PermissionsGuard } from 'common/permissions.guard';
import {
	CreateTransactionDto,
	FilterTransactionsDto,
	UpdateTransactionStatusDto,
} from 'dto/plans.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('transactions')
export class TransactionsController {
	constructor(private transactions: TransactionsService) { }

	// ✅ List all transactions (filtered by user role)
	@Permissions('transactions.read')
	@Get()
	list(@Req() req: any, @Query() filters: FilterTransactionsDto) {
		return this.transactions.list(req.user, filters);
	}

	// ✅ Get transaction statistics (admin only)
	@Permissions('transactions.read')
	@Get('statistics')
	getStatistics(@Req() req: any) {
		return this.transactions.getStatistics(req.user);
	}

	// ✅ Get user's active subscription
	@Get('my-subscription')
	getMySubscription(@Req() req: any) {
		return this.transactions.getActiveSubscription(req.user.id);
	}

	// ✅ Get single transaction
	@Permissions('transactions.read')
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.transactions.get(req.user, Number(id));
	}

	// ✅ Create transaction (subscribe to plan)
	@Permissions('transactions.create')
	@Post()
	create(@Req() req: any, @Body() dto: CreateTransactionDto) {
		return this.transactions.create(req.user, dto);
	}

	// ✅ Update transaction status (admin only)
	@Permissions('transactions.update')
	@Patch(':id/status')
	updateStatus(
		@Req() req: any,
		@Param('id') id: string,
		@Body() dto: UpdateTransactionStatusDto,
	) {
		return this.transactions.updateStatus(req.user, Number(id), dto);
	}

	// ✅ Cancel transaction (user or admin)
	@Permissions('transactions.cancel')
	@Post(':id/cancel')
	cancel(@Req() req: any, @Param('id') id: string) {
		return this.transactions.cancel(req.user, Number(id));
	}
}