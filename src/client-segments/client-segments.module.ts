import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  ClientSegmentEntity,
  ClientSegmentRecipientEntity,
  ClientSegmentTemplateEntity,
} from "entities/clients-segments.entity";
import { ClientEntity } from "entities/clients.entity";
import { ClientSegmentsService } from "./client-segments.service";
import { ClientSegmentTemplatesService } from "./client-segment-templates.service";
import { AudienceModule } from "src/audience/audience.module";
import {
  ClientSegmentsController,
  ClientSegmentTemplatesController,
} from "./client-segments.controller";

@Module({
  imports: [
    AudienceModule,
    TypeOrmModule.forFeature([
      ClientSegmentEntity,
      ClientSegmentRecipientEntity,
      ClientSegmentTemplateEntity,
      ClientEntity,
    ]),
  ],
  controllers: [ClientSegmentsController, ClientSegmentTemplatesController],
  providers: [
    ClientSegmentsService,
    ClientSegmentTemplatesService,
  ],
  exports: [ClientSegmentsService],
})
export class ClientSegmentsModule {}
