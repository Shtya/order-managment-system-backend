import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SafesService } from './safes.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { CreateAccountDto, UpdateAccountDto, CreateTransactionDto, CreateTransferDto, AccountFilterDto, TransactionFilterDto, TransferFilterDto } from 'dto/safe.dto';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('safes')
export class SafesController {
  constructor(private readonly safesService: SafesService) { }

  @Get('stats')
  async getStats(@Req() req: any) {
    return await this.safesService.getStats(req.user);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACCOUNTS
  // ─────────────────────────────────────────────────────────────────────────

  @Get('accounts')
  async listAccounts(@Req() req: any, @Query() q: AccountFilterDto) {
    return await this.safesService.listAccounts(req.user, q);
  }

  @Get('accounts/:id')
  async getAccountById(@Req() req: any, @Param('id') id: string) {
    return await this.safesService.getAccountById(req.user, id);
  }

  @Post('accounts')
  async createAccount(@Req() req: any, @Body() dto: CreateAccountDto) {
    return await this.safesService.createAccount(req.user, dto);
  }

  @Patch('accounts/:id')
  async updateAccount(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    return await this.safesService.updateAccount(req.user, id, dto);
  }

  @Patch('accounts/:id/toggle')
  async toggleAccount(@Req() req: any, @Param('id') id: string) {
    return await this.safesService.toggleAccount(req.user, id);
  }

  @Get('accounts/export')
  async exportAccounts(@Req() req: any, @Res() res: Response, @Query() q: AccountFilterDto) {
    const buffer = await this.safesService.exportAccounts(req.user, q);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=accounts-${Date.now()}.xlsx`);
    res.end(buffer);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRANSACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  @Get('transactions')
  async listTransactions(@Req() req: any, @Query() q: TransactionFilterDto) {
    return await this.safesService.listTransactions(req.user, q);
  }
  @Get('transactions/export')
  async exportTransactions(@Req() req: any, @Res() res: Response, @Query() q: TransactionFilterDto) {
    const buffer = await this.safesService.exportTransactions(req.user, q);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=transactions-${Date.now()}.xlsx`);
    res.end(buffer);
  }

  @Get('transactions/:id')
  async getTransactionById(@Req() req: any, @Param('id') id: string) {
    return await this.safesService.getTransactionById(req.user, id);
  }

  @Post('transactions/deposit')
  async deposit(@Req() req: any, @Body() dto: CreateTransactionDto) {
    return await this.safesService.deposit(req.user, dto);
  }

  @Post('transactions/withdraw')
  async withdraw(@Req() req: any, @Body() dto: CreateTransactionDto) {
    return await this.safesService.withdraw(req.user, dto);
  }



  // ─────────────────────────────────────────────────────────────────────────
  // TRANSFERS
  // ─────────────────────────────────────────────────────────────────────────

  @Get('transfers')
  async listTransfers(@Req() req: any, @Query() q: TransferFilterDto) {
    return await this.safesService.listTransfers(req.user, q);
  }

  @Post('transfers')
  async transfer(@Req() req: any, @Body() dto: CreateTransferDto) {
    return await this.safesService.transfer(req.user, dto);
  }

  @Get('transfers/export')
  async exportTransfers(@Req() req: any, @Res() res: Response, @Query() q: TransferFilterDto) {
    const buffer = await this.safesService.exportTransfers(req.user, q);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=transfers-${Date.now()}.xlsx`);
    res.end(buffer);
  }
}
