import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Query,
    Req,
    UseGuards,
    ParseIntPipe,
    Put,
} from '@nestjs/common';
import { PermissionsGuard } from 'common/permissions.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SubscriptionsService } from './subscription.service';
import { Permissions } from 'common/permissions.decorator';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from 'dto/subscriptions.dto';
import { SubscriptionStatus } from 'entities/plans.entity';


@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('subscriptions')
export class SubscriptionsController {
    constructor(private subscriptions: SubscriptionsService) { }

    // ✅ List subscriptions
    @Permissions('subscriptions.read')
    @Get()
    list(@Req() req: any, @Query() q?: any) {
        return this.subscriptions.list(req.user, q);
    }

    // ✅ Get subscription by ID
    @Permissions('subscriptions.read')
    @Get(':id')
    get(@Req() req: any, @Param('id') id: string) {
        return this.subscriptions.get(req.user, Number(id))
    }

    // ✅ Super Admin create subscription
    @Permissions('subscriptions.create')
    @Post()
    createSubscription(
        @Req() req: any,
        @Body() dto: CreateSubscriptionDto,
    ) {
        return this.subscriptions.createSubscription(
            req.user,
            dto,
        );
    }

    @Permissions('subscriptions.update')
    @Put(':id') // subscription ID in URL
    updateSubscription(
        @Req() req: any,
        @Param('id') id: string,
        @Body() dto: UpdateSubscriptionDto,
    ) {
        return this.subscriptions.updateSubscription(req.user, Number(id), dto);
    }

    // ✅ Update subscription status
    @Permissions('subscriptions.update')
    @Patch(':id/status')
    updateSubscriptionStatus(
        @Req() req: any,
        @Param('id') id: string,
        @Body('status') status: SubscriptionStatus,
    ) {
        return this.subscriptions.updateSubscriptionStatus(
            req.user,
            Number(id),
            status,
        );
    }

    // ✅ Admin get active subscription for specific user
    @Permissions('subscriptions.read')
    @Get('admin/:userId/active')
    getActiveSubscriptionForAdmin(
        @Req() req: any,
        @Param('userId') userId: string,
    ) {
        return this.subscriptions.getActiveSubscriptionForAdmin(
            req.user,
            Number(userId)
        );
    }

    // ✅ Get my active subscription
    @Permissions('subscriptions.read')
    @Get('me/active')
    getMyActiveSubscription(@Req() req: any) {
        return this.subscriptions.getMyActiveSubscription(req.user);
    }

    // ✅ Get subscription statistics
    @Permissions('subscriptions.read')
    @Get('statistics/overview')
    getSubscriptionStatistics(@Req() req: any) {
        return this.subscriptions.getSubscriptionStatistics(req.user);
    }
}