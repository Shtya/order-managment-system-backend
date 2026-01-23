import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'entities/user.entity';

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
		const user = await this.usersRepo.findOne({
			where: { id: payload.sub },
			relations: { role: true }, // أو ['role']
		});


		if (!user || !user.isActive) throw new UnauthorizedException('Invalid user');
		return user;
	}
}
