import { EmailAssetEntity } from "entities/email-asset.entity";
import { EmailAssetsService } from "./email-assets.service";
import { EmailSendingStatusService } from "./email-sending-status.service";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  EmailAccountEntity,
  EmailMessageEntity,
  EmailOAuthStateEntity,
  EmailSubscriptionEntity,
} from "entities/email.entity";
import { EncryptionService } from "common/encryption.service";
import { EmailAccountsService } from "./email-accounts.service";
import { EmailContentService } from "./email-content.service";
import { EmailPolicyService } from "./email-policy.service";
import { EmailService } from "./email.service";
import { EmailController } from "./email.controller";
import { EMAIL_PROVIDERS } from "./email.types";
import { GmailService } from "./providers/gmail.service";
import { GmailController } from "./providers/gmail.controller";
import { SmtpController } from "./providers/smtp.controller";
import { SmtpService } from "./providers/smtp.service";
import { SmtpSecurityService } from "./providers/smtp-security.service";
import { EmailQueueWorker } from "src/queue/queues/email.queue";
import { OrphanFilesModule } from "src/orphan-files/orphan-files.module";
import { OrphanFilesService } from "src/orphan-files/orphan-files.service";

@Module({
  imports: [
    OrphanFilesModule,
    TypeOrmModule.forFeature([
      EmailAssetEntity,
      EmailAccountEntity,
      EmailMessageEntity,
      EmailOAuthStateEntity,
      EmailSubscriptionEntity,
    ]),
  ],
  controllers: [EmailController, GmailController, SmtpController],
  providers: [
    EmailAssetsService,
    EmailSendingStatusService,
    EncryptionService,
    EmailAccountsService,
    EmailContentService,
    EmailPolicyService,
    GmailService,
    SmtpService,
    SmtpSecurityService,
    EmailService,
    EmailQueueWorker,
    { provide: "EMAIL_ORPHAN_FILES", useExisting: OrphanFilesService },
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (gmail: GmailService, smtp: SmtpService) => [gmail, smtp],
      inject: [GmailService, SmtpService],
    },
  ],
  exports: [
    EmailAssetsService,
    EmailService,
    EmailAccountsService,
    EmailContentService,
    EmailPolicyService,
  ],
})
export class EmailModule {}
