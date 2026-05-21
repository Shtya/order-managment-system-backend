import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemErorrsService } from './system-erorrs.service';
import { SystemErorrsController } from './system-erorrs.controller';
import { SystemErrorEntity } from 'entities/system_erorrs.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SystemErrorEntity])],
  controllers: [SystemErorrsController],
  providers: [SystemErorrsService],
  exports: [SystemErorrsService],
})
export class SystemErorrsModule {}
