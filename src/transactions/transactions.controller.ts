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
	Res,
	UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';
import { PermissionsGuard } from 'common/permissions.guard';
import { ManualCreateTransactionDto } from 'dto/plans.dto';
import { Response } from 'express';

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

	@Permissions("transactions.read") // تأكد من مطابقة اسم الصلاحية لديك
	@Get("export")
	async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
		// استدعاء دالة التصدير الجديدة
		const buffer = await this.transactions.exportTransactions(req.user, q);

		const filename = `transactions_report_${new Date().toISOString().split('T')[0]}.xlsx`;

		res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

		return res.send(buffer);
	}

	@Permissions('transactions.read')
	@Get(':id')
	get(@Req() req: any, @Param('id') id: string) {
		return this.transactions.get(req.user, Number(id))
	}

}