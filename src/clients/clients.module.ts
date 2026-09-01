import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import { CustomerEntity } from "entities/customers.entity";
import { OrderEntity, OrderStatusEntity } from "entities/order.entity";
import { OrderTagEntity } from "entities/tag.entity";
import { CustomerModule } from "../customer/customer.module";
import { ClientController } from "./clients.controller";
import { ClientService } from "./clients.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientAddressEntity,
      CustomerEntity,
      OrderEntity,
      OrderStatusEntity,
      OrderTagEntity,
    ]),
    CustomerModule,
  ],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientsModule {}
