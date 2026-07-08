import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerLimitDetail, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    constructor(
        options: ThrottlerModuleOptions,
        storageService: ThrottlerStorage,
        reflector: Reflector,
        moduleRef: ModuleRef,
        private jwtService: JwtService
    ) {
        super(options, storageService, reflector);
    }
    protected async getTracker(req: any): Promise<string> {
        const auth = req.headers.authorization;

        if (auth?.startsWith('Bearer ')) {
            try {
                const token = auth.substring(7);
                const payload = this.jwtService.verify(token);
                return `user:${payload.sub}`;
            } catch { }
        }

        return req.ip;
    }

    protected async throwThrottlingException(
        context: ExecutionContext,
        throttlerLimitDetail: ThrottlerLimitDetail,
    ): Promise<void> {
        throw new HttpException(
            {
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                error: 'Too Many Requests',
                message:
                    "You've reached the allowed request limit. Please wait before trying again.",
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}