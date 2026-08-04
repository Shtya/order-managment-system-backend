import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  SupportTicketActivityEntity,
  SupportTicketAttachmentEntity,
  SupportTicketEntity,
  SupportTicketMessageEntity,
} from "entities/support_tickets.entity";
import { Role, User } from "entities/user.entity";
import { SupportTicketService } from "./support_ticket.service";
import { SupportTicketController } from "./support_ticket.controller";
import { AdminSupportTicketsController } from "./admin_support_tickets.controller";
import { SupportAccessGuard } from "./support-access.guard";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupportTicketEntity,
      SupportTicketMessageEntity,
      SupportTicketAttachmentEntity,
      SupportTicketActivityEntity,
      User,
      Role,
    ]),
  ],
  controllers: [SupportTicketController, AdminSupportTicketsController],
  providers: [SupportTicketService, SupportAccessGuard],
  exports: [SupportTicketService],
})
export class SupportTicketModule {}
