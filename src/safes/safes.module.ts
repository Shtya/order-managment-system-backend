import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SafesService } from './safes.service';
import { SafesController } from './safes.controller';
import { Account, FinancialTransaction, AccountTransfer } from 'entities/safe.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Account, FinancialTransaction, AccountTransfer])],
  controllers: [SafesController],
  providers: [SafesService],
  exports: [SafesService],
})
export class SafesModule {}
