import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport'; // <- use the guard you already use for req.user
import { randomUUID } from 'crypto';
import { tenantId } from 'src/category/category.service';
import { AiDecisionService } from './ai-decision.service';
import {
  ProviderError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
} from './ai-decision.errors';
import type { DecisionState, QuestionMap } from './ai-decision.types';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';

/**
 * Body of the test endpoint. It is an interface on purpose: with a class DTO and
 * ValidationPipe({ whitelist: true }), undecorated properties (state, questions)
 * would be stripped. The provider validates the real shape before anything is billed.
 */
interface DecideBody {
  idempotencyKey?: string;
  state: DecisionState;
  questions: QuestionMap;
  feature?: string;
  model?: string;
}

@Controller('ai-decision')
@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
export class AiDecisionController {
  constructor(private readonly aiDecisionService: AiDecisionService) {}

    /** Testing convenience: outside production a missing key is generated (and echoed back). */
    private generatedKey(): string {
      if (process.env.NODE_ENV === 'production') {
        throw new HttpException(
          'Idempotency-Key header (or idempotencyKey in the body) is required',
          HttpStatus.BAD_REQUEST,
        );
      }
      return `test-${randomUUID()}`;
    }

    
  @Post('decide')
  @HttpCode(200)
  async decide(
    @Req() req: any,
    @Headers('idempotency-key') headerKey: string | undefined,
    @Body() body: DecideBody,
  ) {
    const user = req.user;
    const adminId = tenantId(user);
    if (adminId == null) {
      throw new HttpException(
        'Could not resolve the tenant for this user',
        HttpStatus.FORBIDDEN,
      );
    }

    const idempotencyKey = headerKey ?? body?.idempotencyKey ?? this.generatedKey();

    try {
      const result = await this.aiDecisionService.decide({
        me: user, // the service derives adminId from this with the same tenantId()
        idempotencyKey,
        state: body?.state,
        questions: body?.questions,
        feature: body?.feature ?? 'postman-test',
      });

      // adminId is echoed for testing only, remove it once the flow works.
      return { adminId, idempotencyKey, ...result };
    } catch (err) {
      throw this.aiDecisionService.toHttpException(err);
    }
  }
}
