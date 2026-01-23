import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StoreEntity } from "entities/stores.entity";
import { StoresService } from "./stores.service";
import { StoresController } from "./stores.controller";

@Module({
  imports: [TypeOrmModule.forFeature([StoreEntity])],
  providers: [StoresService],
  controllers: [StoresController],
  exports: [StoresService],
})
export class StoresModule {}
