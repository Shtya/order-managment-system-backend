import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PendingUser, Role, SystemRole, User } from 'entities/user.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { FirebaseService } from './firebase.service';
import { MailService } from '../../common/nodemailer';
import { Response } from 'express';
import { RegisterDto } from 'dto/auth.dto';

@Injectable()
export class AuthService {
	constructor(
		private dataSource: DataSource,
		@InjectRepository(User) private usersRepo: Repository<User>,
		@InjectRepository(PendingUser) private pendingUserRepository: Repository<PendingUser>,
		@InjectRepository(Role) private rolesRepo: Repository<Role>,
		private jwt: JwtService,
		private mail: MailService,
		private firebase: FirebaseService,
	) { }

	RESEND_COOLDOWN_SECONDS = 60;

	// ✅ UPDATED: Include plan in JWT response
	// ✅ UPDATED: Include plan in JWT response
	private async sign(user: User) {

		const plan = user?.subscription?.plan ?? null;

		return {
			accessToken: this.jwt.sign({ sub: user.id }),
			user: {
				id: user.id,
				name: user.name,
				email: user.email,
				role: user.role?.name,
				permissions: user.role?.permissionNames,
				adminId: user.adminId,
				onboardingStatus: user.onboardingStatus,
				currentOnboardingStep: user.currentOnboardingStep,
				plan: plan
					? {
						id: plan.id,
						name: plan.name,
						price: Number(plan.price),
						duration: plan.duration,
						features: plan.features,
						color: plan.color,
						status: user?.subscription?.status ?? null,
						startDate: user?.subscription?.startDate ?? null
					}
					: null,
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


	async register(registerDto: RegisterDto) {
		const { name, email, password, phone, companyName, businessType } = registerDto;

		// 1. Primary Check: Is this email already in the live Users table?
		const exists = await this.usersRepo.findOne({ where: { email } });
		if (exists) throw new BadRequestException('Email already used');

		// 2. Role Check
		const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.ADMIN } });
		if (!userRole) throw new BadRequestException('USER role not seeded');

		// 3. Pending User & Cooldown Logic
		let pendingUser = await this.pendingUserRepository.findOne({ where: { email } });
		const currentTimestamp = Date.now();

		if (pendingUser?.lastSentAt) {
			const timeElapsedSeconds = (Date.now() - Number(pendingUser.lastSentAt)) / 1000;

			// 2. Check if we are still within the cooldown period
			if (timeElapsedSeconds < this.RESEND_COOLDOWN_SECONDS) {
				const remainingSeconds = Math.ceil(this.RESEND_COOLDOWN_SECONDS - timeElapsedSeconds);

				throw new ForbiddenException(
					`Please wait ${remainingSeconds} seconds before requesting a new code.`
				);
			}
		}

		// 4. Generate Security Data
		const otp = this.generateOtp(6); // Plain OTP for the email
		const otpCodeHash = this.hashOtp(otp); // Hashed for the DB
		const passwordHash = await bcrypt.hash(password, 12);

		// Set Expiries
		const otpExpiresAt = Date.now() + 1000 * 60 * 10;

		// 5. Map Data for Upsert
		const pendingData = {
			name,
			email,
			phone,
			passwordHash,
			otpCodeHash,         // Matches your OTP logic
			otpExpiresAt,       // Matches your OTP logic
			otpAttempts: 0,     // Reset attempts on new registration/resend
			lastSentAt: currentTimestamp,
			roleId: userRole.id,
			companyName,
			businessType,
		};

		// 6. Save to Database
		if (pendingUser) {
			const pending = { ...pendingUser, ...pendingData };
			await this.pendingUserRepository.save(pending);
		} else {
			pendingUser = this.pendingUserRepository.create(pendingData);
			await this.pendingUserRepository.save(pendingUser);
		}
		await this.mail.sendRegistrationOtpEmail(email, {
			otp,
			userName: name || 'there',
		});
		// 7. Send the Plain OTP via Email

		return {
			message: 'Verification code sent to your email',
			email
		};
	}

	async verifyRegisterOtp(email: string, otp: string) {
		// 1. Find the pending user
		const pendingUser = await this.pendingUserRepository.findOne({
			where: { email },
			relations: { role: true }
		});

		if (!pendingUser) throw new BadRequestException('Verification session not found');

		// 2. Check Expiration
		const exp = Number(pendingUser.otpExpiresAt) || 0;
		if (!pendingUser.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException('OTP expired,  request new OTP');
		}

		// 3. Handle Attempts
		pendingUser.otpAttempts = (pendingUser.otpAttempts || 0) + 1;

		if (pendingUser.otpAttempts > 5) {
			// Too many tries - delete the hash to force a resend
			pendingUser.otpCodeHash = null;
			pendingUser.otpExpiresAt = null;
			await this.pendingUserRepository.save(pendingUser);
			throw new BadRequestException('Too many attempts, request new OTP');
		}

		// 4. Verify Hash
		const isMatch = this.hashOtp(otp) === pendingUser.otpCodeHash;
		if (!isMatch) {
			await this.pendingUserRepository.save(pendingUser);
			throw new BadRequestException('Invalid OTP');
		}

		// 5. TRANSACTION: Create User and Delete Pending
		// We use the dataSource.transaction to ensure atomicity
		const result = await this.dataSource.transaction(async (manager) => {

			// Create the real user (Mapping fields from pendingUser)
			const newUser = manager.create(User, {
				name: pendingUser.name,
				email: pendingUser.email,
				passwordHash: pendingUser.passwordHash, // Already hashed in register step
				phone: pendingUser.phone,
				adminId: null,
				roleId: pendingUser.roleId,
				// Metadata fields
				businessType: pendingUser.businessType,
				companyName: pendingUser.companyName,
				isActive: true,
				otpVerified: false,
				otpCodeHash: null,
				otpExpiresAt: null,
				otpAttempts: 0,
			});

			const savedUser = await manager.save(newUser);

			// Delete the pending record so it can't be used again
			await manager.delete(PendingUser, pendingUser.id);

			return savedUser;
		});

		// 6. Fetch full user with relations for the token (Plan, Roles, etc.)
		const fullUser = await this.usersRepo.findOneOrFail({
			where: { id: result.id },
			relations: {
				role: true,
				subscription: {
					plan: true
				}
			},
		});

		// 7. Sign and return the user (Login them in automatically)
		return this.sign(fullUser);
	}

	async resendRegisterOtp(email: string) {
		// 1. Find the pending user
		const pendingUser = await this.pendingUserRepository.findOne({ where: { email } });
		if (!pendingUser) {
			throw new BadRequestException('No pending registration found for this email.');
		}

		// 2. Enforce Cooldown (using the bigint/number logic)
		const currentTimestamp = Date.now();
		if (pendingUser.lastSentAt) {
			const timeElapsed = (currentTimestamp - Number(pendingUser.lastSentAt)) / 1000;
			if (timeElapsed < this.RESEND_COOLDOWN_SECONDS) {
				const remaining = Math.ceil(this.RESEND_COOLDOWN_SECONDS - timeElapsed);
				throw new ForbiddenException(`Please wait ${remaining} seconds before resending.`);
			}
		}

		// 3. Generate New OTP and Reset Security State
		const newOtp = this.generateOtp(6);

		pendingUser.otpCodeHash = this.hashOtp(newOtp);
		pendingUser.otpExpiresAt = currentTimestamp + (1000 * 60 * 10); // 10 minutes fresh
		pendingUser.otpAttempts = 0; // 💡 Reset attempts so they can try again
		pendingUser.lastSentAt = currentTimestamp;

		await this.pendingUserRepository.save(pendingUser);

		// 4. Send the New Email
		await this.mail.sendRegistrationOtpEmail(email, {
			otp: newOtp,
			userName: pendingUser.name,
		});

		return { message: 'A new verification code has been sent.' };
	}

	// ✅ UPDATED: Include plan relation on login
	async login(email: string, password: string) {
		const user = await this.usersRepo.findOne({
			where: { email },
			relations: {
				role: true, subscription: {
					plan: true
				}
			}, // ✅ Include plan
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
			relations: {
				role: true, subscription: {
					plan: true
				}
			},
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
			relations: {
				role: true, subscription: {
					plan: true
				}
			}, // ✅ Include plan
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
				isActive: true,
				otpCodeHash: null,
				otpExpiresAt: null,
				otpVerified: false,
				otpAttempts: 0,
			});

			await this.usersRepo.save(user);

			user = await this.usersRepo.findOneOrFail({
				where: { id: user.id },
				relations: {
					role: true, subscription: {
						plan: true
					}
				},
			});
		}

		if (!user.isActive) throw new UnauthorizedException('Account is inactive');

		return this.sign(user);
	}


	createOAuthState(redirectPath: string): string {
		return JSON.stringify({ redirectPath });
	}


	parseOAuthState(state: string): { redirectPath: string; referralCode?: string, type?: string } {
		try {
			return JSON.parse(state);
		} catch (error) {
			return { redirectPath: '/' };
		}
	}

	async handleGoogleCallback(profile: any, state?: string) {
		const email = profile.email;
		const googleId = profile.id;
		const name = profile.name;

		const parsedState = this.parseOAuthState(state);
		const redirectPath = parsedState?.redirectPath || '/';

		if (!email) throw new UnauthorizedException('Google account has no email');

		let user = await this.usersRepo.findOne({
			where: { email },
			relations: {
				role: true, subscription: {
					plan: true
				}
			}, // ✅ Include plan
		});

		if (!user) {
			const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.ADMIN } });
			if (!userRole) throw new BadRequestException('USER role not seeded');

			user = this.usersRepo.create({
				name: name || 'Google User',
				email,
				passwordHash: null,
				roleId: userRole.id,
				googleId: googleId,
				adminId: null,
				isActive: true,
				otpCodeHash: null,
				otpExpiresAt: null,
				otpVerified: false,
				otpAttempts: 0,
			});

			await this.usersRepo.save(user);

			user = await this.usersRepo.findOneOrFail({
				where: { id: user.id },
				relations: {
					role: true, subscription: {
						plan: true
					}
				},
			});
		}

		if (!user.isActive) throw new UnauthorizedException('Account is inactive');

		const accessToken = this.jwt.sign({ sub: user.id });
		const newResult = { accessToken, redirectPath };

		return newResult;
	}

	async signUser(id) {
		const user = await this.usersRepo.findOne({
			where: { id },
			relations: {
				role: true, subscription: {
					plan: true
				}
			}, // ✅ Include plan
		});

		if (!user) throw new NotFoundException('User not found');

		const result = await this.sign(user);

		return result;
	}
}