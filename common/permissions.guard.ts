import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { SystemRole, User } from 'entities/user.entity';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

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

    const missing = required.filter((p) => !userPerms.includes(p));

    if (missing.length) {
      throw new ForbiddenException(`Missing required permissions : ${required}`);
    }

    return true;
  }
}
