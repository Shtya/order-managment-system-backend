import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  ClientTagEntity,
  OrderTagEntity,
  TagAutomationEntity,
  TagEntity,
} from "entities/tag.entity";
import { OrderEntity } from "entities/order.entity";
import { ClientEntity } from "entities/clients.entity";
import { TagsService } from "./tags.service";
import { TagAutomationsService } from "./tag-automations.service";
import { TagsAssignmentService } from "./tags-assignment.service";
import { TagAutomationEvaluator } from "./tag-automation.evaluator";
import { QueueModule } from "src/queue/queue.module";
import { ClientsModule } from "src/clients/clients.module";
import {
  ClientTagsController,
  OrderTagsController,
  TagAutomationsController,
  TagsController,
} from "./tags.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TagEntity,
      OrderTagEntity,
      ClientTagEntity,
      TagAutomationEntity,
      OrderEntity,
      ClientEntity,
    ]),
    forwardRef(() => QueueModule),
    ClientsModule,
  ],
  controllers: [
    TagsController,
    TagAutomationsController,
    OrderTagsController,
    ClientTagsController,
  ],
  providers: [
    TagsService,
    TagAutomationsService,
    TagsAssignmentService,
    TagAutomationEvaluator,
  ],
  exports: [TagsAssignmentService, TagAutomationEvaluator, TagsService],
})
export class TagsModule {}
