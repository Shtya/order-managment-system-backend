// subscription.guard.ts
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_SUBSCRIPTION_KEY } from './require-subscription.decorator';
import { SystemRole } from 'entities/user.entity';

@Injectable()
export class SubscriptionGuard implements CanActivate {
    constructor(private reflector: Reflector) { }

    canActivate(ctx: ExecutionContext): boolean {
        const isRequired = this.reflector.getAllAndOverride<boolean>(
            REQUIRE_SUBSCRIPTION_KEY,
            [ctx.getHandler(), ctx.getClass()]
        );

        // If the decorator isn't used, or is explicitly set to false, allow access.
        if (isRequired === undefined || isRequired === false) {
            return true;
        }

        const req = ctx.switchToHttp().getRequest();
        const user = req.user;

        if (user?.role?.name === SystemRole.SUPER_ADMIN) return true;
        const activeSubscription = user?.activeSubscription;


        if (!activeSubscription) {
            throw new ForbiddenException({
                message: 'Subscription Required',
                reason: 'Your active plan has expired or you do not have one.',
                code: 'PLAN_EXPIRED', // Helpful for your frontend to trigger a paywall/upgrade modal
            });
        }

        return true;
    }
}