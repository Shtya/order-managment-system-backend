import { Module } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationFlowEntity } from 'entities/automation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AutomationFlowEntity])],
  controllers: [AutomationController],
  providers: [AutomationService],
})
export class AutomationModule {}
