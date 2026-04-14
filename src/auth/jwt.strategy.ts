import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { SystemRole, User } from 'entities/user.entity';
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
			// 
			.leftJoinAndSelect('user.role', 'role')


			.leftJoinAndSelect('user.admin', 'admin')


			.leftJoinAndSelect(
				'user.subscriptions',
				'ownSub',
				'ownSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('ownSub.plan', 'ownPlan')


			.leftJoinAndSelect(
				'admin.subscriptions',
				'adminSub',
				'adminSub.status = :status',
				{ status: SubscriptionStatus.ACTIVE }
			)
			.leftJoinAndSelect('adminSub.plan', 'adminPlan')

			.where('user.id = :userId', { userId: payload.sub })
			.getOne();

		if (!user || !user.isActive) throw new UnauthorizedException('Invalid user');


		const isAdmin = user.role?.name === SystemRole.ADMIN;
		const effectiveSub = (isAdmin || !user.admin)
			? user.subscriptions?.[0]
			: user.admin?.subscriptions?.[0];


		user.subscriptions = effectiveSub ? [effectiveSub] : [];

		delete user.admin;

		return user;
	}
}
