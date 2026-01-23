import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { WarehouseEntity } from "entities/warehouses.entity";
import { User } from "entities/user.entity";
import { WarehousesService } from "./warehouse.service";
import { WarehousesController } from "./warehouse.controller";

@Module({
  imports: [TypeOrmModule.forFeature([WarehouseEntity, User])],
  providers: [WarehousesService],
  controllers: [WarehousesController],
  exports: [WarehousesService],
})
export class WarehousesModule {}
