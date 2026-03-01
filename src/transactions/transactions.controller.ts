import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseIntPipe,
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
import { ManualCreateTransactionDto } from 'dto/plans.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('transactions')
export class TransactionsController {
	constructor(private transactions: TransactionsService) { }

	// ✅ List (with filters)
	@Permissions('transactions.read')
	@Get()
	list(@Req() req: any, @Query() filters: any) {
		return this.transactions.list(req.user, filters);
	}

	// ✅ Get single transaction by id
	@Permissions('transactions.read')
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.transactions.get(req.user, Number(id))
	}

	// ✅ Get statistics
	@Permissions('transactions.read')
	@Get('statistics/overview')
	getStatistics(@Req() req: any) {
		return this.transactions.getStatistics(req.user);
	}

	// ✅ Cancel transaction
	@Permissions('transactions.update')
	@Patch(':id/cancel')
	cancel(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
		return this.transactions.cancel(req.user, id);
	}

	// ✅ Super Admin: Manual Create Completed Transaction
	@Permissions('transactions.create')
	@Post('manual')
	manualCreateCompletedTransaction(
		@Req() req: any,
		@Body() dto: ManualCreateTransactionDto,
	) {
		return this.transactions.manualCreateCompletedTransaction(
			req.user,
			dto,
		);
	}
}