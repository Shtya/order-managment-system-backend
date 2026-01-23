import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role, SystemRole, User } from 'entities/user.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { FirebaseService } from './firebase.service';
import { MailService } from '../../common/nodemailer';

@Injectable()
export class AuthService {
	constructor(
		@InjectRepository(User) private usersRepo: Repository<User>,
		@InjectRepository(Role) private rolesRepo: Repository<Role>,
		private jwt: JwtService,
		private mail: MailService,
		private firebase: FirebaseService,
	) { }

	// ✅ UPDATED: Include plan in JWT response
	private sign(user: User) {
		return {
			accessToken: this.jwt.sign({ sub: user.id }),
			user: {
				id: user.id,
				name: user.name,
				email: user.email,
				role: user.role?.name,
				// ✅ NEW: Include plan info
				plan: user.plan ? {
					id: user.plan.id,
					name: user.plan.name,
					price: Number(user.plan.price),
					duration: user.plan.duration,
					features: user.plan.features,
					color: user.plan.color,
				} : null,
			},
		};
	}

	private generateOtp(len = 6) {
		const n = crypto.randomInt(0, 10 ** len);
		return n.toString().padStart(len, '0');
	}

	private hashOtp(otp: string) {
		return crypto.createHash('sha256').update(otp).digest('hex');
	}

	async register(name: string, email: string, password: string) {
		const exists = await this.usersRepo.findOne({ where: { email } });
		if (exists) throw new BadRequestException('Email already used');

		const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.USER } });
		if (!userRole) throw new BadRequestException('USER role not seeded');

		const passwordHash = await bcrypt.hash(password, 10);

		const user = this.usersRepo.create({
			name,
			email,
			passwordHash,
			roleId: userRole.id,
			adminId: null,
			planId: null, // ✅ NEW: No plan on self-registration
			isActive: true,
			otpCodeHash: null,
			otpExpiresAt: null,
			otpVerified: false,
			otpAttempts: 0,
		});

		await this.usersRepo.save(user);

		// ✅ UPDATED: Include plan relation
		const full = await this.usersRepo.findOneOrFail({
			where: { id: user.id },
			relations: { role: true, plan: true },
		});

		return this.sign(full);
	}

	// ✅ UPDATED: Include plan relation on login
	async login(email: string, password: string) {
		const user = await this.usersRepo.findOne({
			where: { email },
			relations: { role: true, plan: true }, // ✅ Include plan
		});

		if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

		const ok = await bcrypt.compare(password, user.passwordHash || '');
		if (!ok) throw new UnauthorizedException('Invalid credentials');

		return this.sign(user);
	}

	// ======================
	// OTP RESET FLOW (unchanged but include plan on final response)
	// ======================

	async sendResetOtp(email: string) {
		const user = await this.usersRepo.findOne({ where: { email } });

		if (!user) {
			return { message: 'If the email exists, you will receive an OTP.' };
		}

		const otp = this.generateOtp(6);
		user.otpCodeHash = this.hashOtp(otp);
		user.otpExpiresAt = Date.now() + 1000 * 60 * 10;
		user.otpVerified = false;
		user.otpAttempts = 0;

		await this.usersRepo.save(user);

		await this.mail.sendOtpEmail(user.email, {
			otp,
			userName: user.name || 'there',
		});

		return { message: 'OTP sent if email exists' };
	}

	async verifyResetOtp(email: string, otp: string) {
		const user = await this.usersRepo.findOne({ where: { email } });
		if (!user) throw new BadRequestException('Invalid OTP');

		const exp = user.otpExpiresAt || 0;
		if (!user.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException('OTP expired');
		}

		user.otpAttempts = (user.otpAttempts || 0) + 1;
		if (user.otpAttempts > 5) {
			user.otpCodeHash = null;
			user.otpExpiresAt = null;
			user.otpVerified = false;
			await this.usersRepo.save(user);
			throw new BadRequestException('Too many attempts, request new OTP');
		}

		const ok = this.hashOtp(otp) === user.otpCodeHash;
		if (!ok) {
			await this.usersRepo.save(user);
			throw new BadRequestException('Invalid OTP');
		}

		user.otpVerified = true;
		await this.usersRepo.save(user);

		return { message: 'OTP verified' };
	}

	// ✅ UPDATED: Include plan relation
	async resetPasswordByOtp(email: string, newPassword: string) {
		const user = await this.usersRepo.findOne({ where: { email } });
		if (!user) throw new BadRequestException('Invalid request');

		const exp = user.otpExpiresAt || 0;
		if (!user.otpVerified || !user.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException('OTP verification required');
		}

		user.passwordHash = await bcrypt.hash(newPassword, 10);
		user.otpCodeHash = null;
		user.otpExpiresAt = null;
		user.otpVerified = false;
		user.otpAttempts = 0;

		await this.usersRepo.save(user);

		// ✅ UPDATED: Include plan
		const full = await this.usersRepo.findOneOrFail({
			where: { id: user.id },
			relations: { role: true, plan: true },
		});

		return {
			message: 'Password updated successfully',
			...this.sign(full),
		};
	}

	// ✅ UPDATED: Include plan relation
	async googleLogin(idToken: string, fallbackName?: string) {
		const decoded = await this.firebase.verifyIdToken(idToken);

		const email = decoded.email;
		if (!email) throw new UnauthorizedException('Google account has no email');

		let user = await this.usersRepo.findOne({
			where: { email },
			relations: { role: true, plan: true }, // ✅ Include plan
		});

		if (!user) {
			const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.USER } });
			if (!userRole) throw new BadRequestException('USER role not seeded');

			user = this.usersRepo.create({
				name: decoded.name || fallbackName || 'Google User',
				email,
				passwordHash: null,
				roleId: userRole.id,
				adminId: null,
				planId: null, // ✅ NEW: No plan on Google signup
				isActive: true,
				otpCodeHash: null,
				otpExpiresAt: null,
				otpVerified: false,
				otpAttempts: 0,
			});

			await this.usersRepo.save(user);

			user = await this.usersRepo.findOneOrFail({
				where: { id: user.id },
				relations: { role: true, plan: true },
			});
		}

		if (!user.isActive) throw new UnauthorizedException('Account is inactive');

		return this.sign(user);
	}
}