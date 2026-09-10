import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ShippingAssigningRuleEntity } from "entities/shipping-assigning.entity";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { StoreEntity } from "entities/stores.entity";
import { CityEntity } from "entities/cities.entity";
import { ShippingAssigningService } from "./shipping-assigning.service";
import { ShippingAssigningController } from "./shipping-assigning.controller";
import { ShippingModule } from "src/shipping/shipping.module";
import { StoresModule } from "src/stores/stores.module";
import { CitiesModule } from "src/cities/cities.module";

@Module({
  imports: [
    forwardRef(() => ShippingModule),
    forwardRef(() => StoresModule),
    forwardRef(() => CitiesModule),
    TypeOrmModule.forFeature([
      ShippingAssigningRuleEntity,
      ShippingCompanyEntity,
      StoreEntity,
      CityEntity,
    ]),
  ],
  controllers: [ShippingAssigningController],
  providers: [ShippingAssigningService],
  exports: [ShippingAssigningService],
})
export class ShippingAssigningModule {}
