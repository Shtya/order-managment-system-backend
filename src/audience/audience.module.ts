import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ClientEntity } from "entities/clients.entity";
import { AudienceController } from "./audience.controller";
import { AudienceService } from "./audience.service";

@Module({
  imports: [TypeOrmModule.forFeature([ClientEntity])],
  controllers: [AudienceController],
  providers: [AudienceService],
  exports: [AudienceService],
})
export class AudienceModule {}
