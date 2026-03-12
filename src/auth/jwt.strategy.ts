import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'entities/user.entity';
import { SubscriptionStatus } from 'entities/plans.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		@InjectRepository(User) private usersRepo: Repository<User>,
	) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			secretOrKey: process.env.JWT_SECRET || 'dev_secret_change_me',
		});
	}

	async validate(payload: { sub: number }) {

		const user = await this.usersRepo.createQueryBuilder('user')
			// Join Role
			.leftJoinAndSelect('user.role', 'role')

			// Join only the ACTIVE subscription
			.leftJoinAndSelect(
				'user.subscriptions',
				'subscription',
				'subscription.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)

			// Join the Plan details for that active subscription
			.leftJoinAndSelect('subscription.plan', 'plan')

			.where('user.id = :userId', { userId: payload.sub })
			.getOne();


		if (!user || !user.isActive) throw new UnauthorizedException('Invalid user');
		return user;
	}
}
