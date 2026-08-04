import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { SystemRole } from "entities/user.entity";
import { TranslationService } from "common/translation.service";

export const SUPPORT_ROLE_NAME = "support";

export function hasSupportAccess(me: any): boolean {
  const roleName = me?.role?.name;
  return roleName === SystemRole.SUPER_ADMIN || roleName === SUPPORT_ROLE_NAME;
}

@Injectable()
export class SupportAccessGuard implements CanActivate {
  constructor(private readonly translations: TranslationService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (hasSupportAccess(req.user)) return true;

    throw new ForbiddenException(
      this.translations.t("domains.support_tickets.admin_access_denied"),
    );
  }
}
