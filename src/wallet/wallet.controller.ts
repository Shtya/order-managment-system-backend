import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SystemRole } from 'entities/user.entity';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) { }

  // Get current admin wallet
  @Permissions("wallet.read")
  @Get('my-wallet')
  async getMyWallet(@Req() req: any) {
    return this.walletService.getOrCreateWallet(req.user.id);
  }

  // Super Admin: Get or Create Wallet for a specific user
  @Permissions("wallet.read")
  @Get('admin/user-wallet/:userId')
  async getUserWallet(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: string
  ) {
    return this.walletService.getOrCreateWalletSuper(req.user, userId);
  }

  // Initiate Top-up
  @Permissions("wallet.update")
  @Post('top-up')
  async topUp(@Req() req: any, @Body('amount') amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    return this.walletService.topUp(req.user, amount);
  }

  // Super Admin Balance Control
  @Permissions("wallet.update")
  @Post('admin/adjust')
  async adjustBalance(
    @Req() req: any,
    @Body() dto: { userId: string; amount: number; note: string }
  ) {
    return this.walletService.adjustBalance(req.user, dto.userId, dto.amount, dto.note);
  }
}