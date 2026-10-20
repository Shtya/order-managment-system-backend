import { Body, Controller, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { SmtpConnectionDto, SmtpTestConnectionDto, UpdateSmtpConnectionDto } from "dto/email.dto";
import { EmailAccountsService } from "../email-accounts.service";
import { SmtpService } from "./smtp.service";

@Controller("email/accounts")
@UseGuards(JwtAuthGuard)
export class SmtpController {
  constructor(private readonly smtp: SmtpService, private readonly accounts: EmailAccountsService) {}

  @Post("smtp/test")
  test(@Req() req: any, @Body() dto: SmtpTestConnectionDto) {
    return this.smtp.test(this.accounts.context(req.user), dto);
  }

  @Post("smtp")
  create(@Req() req: any, @Body() dto: SmtpConnectionDto) {
    return this.smtp.create(this.accounts.context(req.user), dto);
  }

  @Patch(":id/smtp")
  update(@Req() req: any, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateSmtpConnectionDto) {
    return this.smtp.update(this.accounts.context(req.user), id, dto);
  }
}
