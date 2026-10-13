import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/** Decode `sub` from a Bearer JWT without verifying. Empty if missing/malformed. */
export function bearerSub(req: any): string | null {
    const auth = req?.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    try {
        const payloadBase64 = auth.substring(7).split('.')[1];
        if (!payloadBase64) return null;
        const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
        return payload?.sub ? String(payload.sub) : null;
    } catch {
        return null;
    }
}

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {

    protected async getTracker(req: any): Promise<string> {
        const sub = bearerSub(req);
        if (sub) return `user:${sub}`;
        return Promise.resolve(req.ip);
    }

    protected async throwThrottlingException(
        context: ExecutionContext,
        throttlerLimitDetail: ThrottlerLimitDetail,
    ): Promise<void> {
        throw new HttpException(
            {
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                error: "Too Many Requests",
                message: "You've reached the allowed request limit. Please wait before trying again.",
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}