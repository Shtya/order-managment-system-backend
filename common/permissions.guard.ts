import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole, User } from 'entities/user.entity';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { TranslationService } from './translation.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Inject(forwardRef(() => TranslationService))
    private readonly translations: TranslationService,
  ) { }

  canActivate(ctx: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) || [];

    if (!required.length) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: User | undefined = req.user;

    if (!user) {
      throw new ForbiddenException({
        message: this.translations.t('auth.access_denied'),
        reason: 'User not authenticated',
        requiredPermissions: required,
      });
    }

    // super admin bypass
    if (user.role?.name === SystemRole.SUPER_ADMIN) return true;

    const userPerms = user.role?.permissionNames || [];

    if (userPerms.includes('*')) return true;

    const hasPermission = required.some((p) => userPerms.includes(p));

    if (!hasPermission) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: this.translations.t('auth.required_one', {
          args: { permissions: this.formatPermissions(required) },
        }),
        requiredPermissions: required,
      });
    }

    return true;
  }

  /** Localized permission display names, falling back to the raw key. */
  private formatPermissions(required: string[]): string {
    const separator = this.translations.t('auth.permissions_separator');
    return required
      .map((perm) => {
        const key = `auth.permissionsItems.${perm.replace(/\./g, '_')}`;
        const label = this.translations.t(key as any);
        return typeof label === 'string' && label && label !== key ? label : perm;
      })
      .join(separator);
  }
}
