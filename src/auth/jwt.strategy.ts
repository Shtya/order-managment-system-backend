import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private authService: AuthService,
	) {
		super({
			jwtFromRequest: ExtractJwt.fromExtractors([
				(req) => {
					const authHeader = req?.headers?.authorization;

					if (authHeader) {
						return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
					}

					if (req?.query?.token) {
						return req.query.token;
					}

					return null;
				},
			]),
			secretOrKey: process.env.JWT_SECRET || 'dev_secret_change_me',
		});
	}

	async validate(payload: { sub: number }) {
		return this.authService.validatePayload(payload);
	}
}
