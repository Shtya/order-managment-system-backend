import { ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerLimitDetail
 } from '@nestjs/throttler';
import { TranslationService } from './translation.service';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {

    protected async getTracker(req: any): Promise<string> {
        const auth = req.headers.authorization;

       if (auth?.startsWith('Bearer ')) {
            try {
                const token = auth.substring(7);
                
                // JWTs are formatted as: header.payload.signature
                const payloadBase64 = token.split('.')[1]; 
                
                if (payloadBase64) {
                    // Decode the Base64 payload using Node's native Buffer
                    const decodedPayload = Buffer.from(payloadBase64, 'base64').toString('utf8');
                    const payload = JSON.parse(decodedPayload);
                    
                    if (payload.sub) {
                        return `user:${payload.sub}`;
                    }
                }
            } catch { 
                // If the token is malformed, it silently falls back to IP tracking
            }
        }

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