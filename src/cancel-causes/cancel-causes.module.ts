import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  CancelCauseEntity,
  OrderCancelCauseEntity,
} from "entities/cancel-cause.entity";
import { OrderEntity } from "entities/order.entity";
import { CancelCausesService } from "./cancel-causes.service";
import { CancelCausesController } from "./cancel-causes.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CancelCauseEntity,
      OrderCancelCauseEntity,
      OrderEntity,
    ]),
  ],
  controllers: [CancelCausesController],
  providers: [CancelCausesService],
  exports: [CancelCausesService],
})
export class CancelCausesModule {}
