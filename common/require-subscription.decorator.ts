// require-subscription.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SUBSCRIPTION_KEY = 'require_subscription';

export const RequireSubscription = (required: boolean = true) =>
    SetMetadata(REQUIRE_SUBSCRIPTION_KEY, required);