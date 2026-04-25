import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole, User } from 'entities/user.entity';
import { PERMISSIONS_KEY } from './permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

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
        message: 'Access denied',
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
      throw new ForbiddenException(
        `You need at least one of the following permissions: ${required.join(', ')}`
      );
    }

    return true;
  }
}
