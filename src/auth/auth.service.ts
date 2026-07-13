import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Company, OnboardingStep, PendingUser, Role, SystemRole, User } from 'entities/user.entity';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { FirebaseService } from './firebase.service';
import { MailService } from '../../common/nodemailer';
import { RegisterDto } from 'dto/auth.dto';
import { SubscriptionStatus } from 'entities/plans.entity';
import { UsersService } from 'src/users/users.service';
import { RequestTranslationService, TranslationService } from 'common/translation.service';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';

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
		@Inject(forwardRef(() => UsersService))
		private usersService: UsersService,
		private translations: TranslationService,
		private requestTranslations: RequestTranslationService,
		private notificationService: NotificationService,
	) { }

	RESEND_COOLDOWN_SECONDS = 60;

	public async sign(user: User) {

		return {
			accessToken: this.jwt.sign({ sub: user.id, isOnboarding: user.currentOnboardingStep !== OnboardingStep?.FINISHED }),
			user,
		};
	}

	async validatePayload(payload: { sub: number }) {
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

		if (!user || !user.isActive) throw new UnauthorizedException(this.translations.t('domains.auth.invalid_user'));


		const isAdmin = user.role?.name === SystemRole.ADMIN;
		const effectiveSub = (isAdmin || !user.admin)
			? user.subscriptions?.[0]
			: user.admin?.subscriptions?.[0];


		user.subscriptions = effectiveSub ? [effectiveSub] : [];

		delete user.admin;

		return user;
	}

	private generateOtp(len = 6) {
		const n = crypto.randomInt(0, 10 ** len);
		return n.toString().padStart(len, '0');
	}

	private hashOtp(otp: string) {
		return crypto.createHash('sha256').update(otp).digest('hex');
	}



	async isEmailExists(email: string): Promise<boolean> {

		const normalizedEmail = email.trim().toLowerCase();

		const user = await this.usersRepo.findOne({
			where: { email: normalizedEmail }
		});

		return !!user;
	}


	async register(registerDto: RegisterDto) {
		const { name, email, password, phone, companyName, businessType } = registerDto;

		// 1. Primary Check: Is this email already in the live Users table?
		const exists = await this.usersRepo.findOne({ where: { email } });
		if (exists) throw new BadRequestException(this.translations.t('domains.auth.email_already_used'));

		// 2. Role Check
		const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.ADMIN } });
		if (!userRole) throw new BadRequestException(this.translations.t('domains.auth.role_not_seeded'));

		// 3. Pending User & Cooldown Logic
		let pendingUser = await this.pendingUserRepository.findOne({ where: { email } });
		const currentTimestamp = Date.now();

		if (pendingUser?.lastSentAt) {
			const timeElapsedSeconds = (Date.now() - Number(pendingUser.lastSentAt)) / 1000;

			// 2. Check if we are still within the cooldown period
			if (timeElapsedSeconds < this.RESEND_COOLDOWN_SECONDS) {
				const remainingSeconds = Math.ceil(this.RESEND_COOLDOWN_SECONDS - timeElapsedSeconds);

				throw new ForbiddenException(
					this.translations.t('domains.auth.cooldown_wait', { args: { remainingSeconds } })
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
			message: this.translations.t('common.verification_code_sent'),
			email
		};
	}

	async verifyRegisterOtp(email: string, otp: string) {
		// 1. Find the pending user
		const pendingUser = await this.pendingUserRepository.findOne({
			where: { email },
			relations: { role: true }
		});

		if (!pendingUser) throw new BadRequestException(this.translations.t('domains.auth.verification_session_not_found'));

		// 2. Check Expiration
		const exp = Number(pendingUser.otpExpiresAt) || 0;
		if (!pendingUser.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException(this.translations.t('domains.auth.otp_expired'));
		}

		// 3. Handle Attempts
		pendingUser.otpAttempts = (pendingUser.otpAttempts || 0) + 1;

		if (pendingUser.otpAttempts > 5) {
			// Too many tries - delete the hash to force a resend
			pendingUser.otpCodeHash = null;
			pendingUser.otpExpiresAt = null;
			await this.pendingUserRepository.save(pendingUser);
			throw new BadRequestException(this.translations.t('domains.auth.too_many_attempts'));
		}

		// 4. Verify Hash
		const isMatch = this.hashOtp(otp) === pendingUser.otpCodeHash;
		if (!isMatch) {
			await this.pendingUserRepository.save(pendingUser);
			throw new BadRequestException(this.translations.t('domains.auth.invalid_otp'));
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
				isActive: true,
				otpVerified: false,
				otpCodeHash: null,
				otpExpiresAt: null,
				otpAttempts: 0,
			});

			const savedUser = await manager.save(newUser);

			if (pendingUser.companyName) {
				const company = manager.create(Company, {
					name: pendingUser.companyName,
					businessType: pendingUser.businessType,
					user: savedUser
				});

				await manager.save(company);
			}


			// Delete the pending record so it can't be used again
			await manager.delete(PendingUser, pendingUser.id);


			return savedUser;
		});

		// 6. Fetch full user with relations for the token (Plan, Roles, etc.)
		const fullUser = await this.usersService.getFullUser(result.id)

		// 7. Sign and return the user (Login them in automatically)
		return this.sign(fullUser);
	}

	async resendRegisterOtp(email: string) {
		// 1. Find the pending user
		const pendingUser = await this.pendingUserRepository.findOne({ where: { email } });
		if (!pendingUser) {
			throw new BadRequestException(this.translations.t('domains.auth.no_pending_email_change'));
		}

		// 2. Enforce Cooldown (using the bigint/number logic)
		const currentTimestamp = Date.now();
		// if (pendingUser.lastSentAt) {
		// 	const timeElapsed = (currentTimestamp - Number(pendingUser.lastSentAt)) / 1000;
		// 	if (timeElapsed < this.RESEND_COOLDOWN_SECONDS) {
		// 		const remaining = Math.ceil(this.RESEND_COOLDOWN_SECONDS - timeElapsed);
		// 		throw new ForbiddenException(`Please wait ${remaining} seconds before resending.`);
		// 	}
		// }

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

		return { message: this.translations.t('common.verification_code_sent') };
	}

	// ✅ UPDATED: Include plan relation on login
	async login(email: string, password: string) {
		const user = await this.usersService.getFullUserByEmail(email, true);

		if (!user || !user.isActive) throw new UnauthorizedException(this.translations.t('domains.auth.invalid_credentials'));

		const ok = await bcrypt.compare(password, user.passwordHash || '');
		if (!ok) throw new UnauthorizedException(this.translations.t('domains.auth.invalid_credentials'));

		const { passwordHash, ...finalUser } = user;
		return this.sign(finalUser as User);
	}

	// ======================
	// OTP RESET FLOW (unchanged but include plan on final response)
	// ======================

	async sendResetOtp(email: string) {
		const user = await this.usersRepo.findOne({ where: { email } });

		if (!user) {
			return { message: this.translations.t('common.otp_conditional_receive') };
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

		return { message: this.translations.t('common.otp_sent_conditional') };
	}

	// auth.service.ts

	async resendEmailChangeOtp(userId: string) {
		const user = await this.usersRepo.findOne({ where: { id: userId } });

		if (!user || !user.pendingNewEmail) {
			throw new BadRequestException(this.translations.t('domains.auth.no_pending_email_change'));
		}

		// Optional: Check cooldown (using your RESEND_COOLDOWN_SECONDS)
		// if (user.lastOtpSentAt && Date.now() < user.lastOtpSentAt + this.RESEND_COOLDOWN_SECONDS * 1000) {
		//    throw new BadRequestException('Please wait before requesting another code');
		// }

		const otp = this.generateOtp(6);
		user.newEmailOtpCodeHash = this.hashOtp(otp);
		user.newEmailOtpExpiresAt = Date.now() + 1000 * 60 * 10; // 10 minutes
		user.newEmailOtpAttempts = 0;

		await this.usersRepo.save(user);

		await this.mail.sendEmailChangeOtpEmail(user.pendingNewEmail, {
			otp,
			userName: user.name || 'there',
		});

		return { message: this.translations.t('common.new_code_sent') };
	}

	async verifyResetOtp(email: string, otp: string) {
		const user = await this.usersRepo.findOne({ where: { email } });
		if (!user) throw new BadRequestException(this.translations.t('domains.auth.invalid_request'));

		const exp = user.otpExpiresAt || 0;
		if (!user.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException(this.translations.t('domains.auth.otp_expired'));
		}

		user.otpAttempts = (user.otpAttempts || 0) + 1;
		if (user.otpAttempts > 5) {
			user.otpCodeHash = null;
			user.otpExpiresAt = null;
			user.otpVerified = false;
			await this.usersRepo.save(user);
			throw new BadRequestException(this.translations.t('domains.auth.too_many_attempts'));
		}

		const ok = this.hashOtp(otp) === user.otpCodeHash;
		if (!ok) {
			await this.usersRepo.save(user);
			throw new BadRequestException(this.translations.t('domains.auth.invalid_otp'));
		}

		user.otpVerified = true;
		await this.usersRepo.save(user);

		return { message: this.translations.t('common.otp_verified') };
	}

	// ✅ UPDATED: Include plan relation
	async resetPasswordByOtp(email: string, newPassword: string) {
		const user = await this.usersRepo.findOne({ where: { email } });
		if (!user) throw new BadRequestException(this.translations.t('domains.auth.invalid_request'));

		const exp = user.otpExpiresAt || 0;
		if (!user.otpVerified || !user.otpCodeHash || Date.now() > exp) {
			throw new BadRequestException(this.translations.t('domains.auth.otp_verification_required'));
		}

		user.passwordHash = await bcrypt.hash(newPassword, 10);
		user.otpCodeHash = null;
		user.otpExpiresAt = null;
		user.otpVerified = false;
		user.otpAttempts = 0;

		await this.usersRepo.save(user);

		// ✅ UPDATED: Include plan
		const fullUser = await this.usersService.getFullUser(user.id);
		return {
			message: this.translations.t('common.password_updated'),
			...this.sign(fullUser),
		};
	}

	// ✅ UPDATED: Include plan relation
	async googleLogin(idToken: string, fallbackName?: string) {
		const decoded = await this.firebase.verifyIdToken(idToken);

		const email = decoded.email;
		if (!email) throw new UnauthorizedException(this.translations.t('domains.auth.google_no_email'));

		let user = await this.usersService.getFullUserByEmail(email)

		if (!user) {
			const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.USER } });
			if (!userRole) throw new BadRequestException(this.translations.t('domains.auth.role_not_seeded'));

			user = this.usersRepo.create({
				name: decoded.name || fallbackName || this.translations.t('domains.auth.fallback_google_user'),
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

			user = await this.usersService.getFullUser(user.id)
		}

		if (!user.isActive) throw new UnauthorizedException(this.translations.t('domains.auth.account_inactive'));

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

		if (!email) throw new UnauthorizedException(this.translations.t('domains.auth.google_no_email'));

		let user = await this.usersRepo.createQueryBuilder('user')
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

			.where('user.email = :email', { email })
			.getOne();

		if (!user) {
			const userRole = await this.rolesRepo.findOne({ where: { name: SystemRole.ADMIN } });
			if (!userRole) throw new BadRequestException(this.translations.t('domains.auth.role_not_seeded'));

			user = this.usersRepo.create({
				name: name || '',
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

			user = await this.usersService.getFullUser(user.id)

		}

		if (!user.isActive) throw new UnauthorizedException(this.translations.t('domains.auth.account_inactive'));

		const { accessToken } = await this.sign(user);
		const newResult = { accessToken, redirectPath };

		return newResult;
	}

	async signUser(id) {
		const user = await this.usersService.getFullUser(id);

		if (!user) throw new NotFoundException(this.translations.t('domains.auth.user_not_found'));

		const result = await this.sign(user);

		return result;
	}

	async changePasswordByOldPassword(userId: string, oldPassword: string, newPassword: string) {
		const user = await this.usersRepo.findOne({
			where: { id: userId },
			select: {
				passwordHash: true,
				email: true,
				name: true,
				id: true,
			}
		});
		if (!user) throw new NotFoundException(this.translations.t('domains.auth.user_not_found'));

		// Verify old password
		const isMatch = await bcrypt.compare(oldPassword, user.passwordHash || '');
		if (!isMatch) throw new BadRequestException(this.translations.t('domains.auth.invalid_current_password'));

		// Hash and update new password
		user.passwordHash = await bcrypt.hash(newPassword, 10);
		await this.usersRepo.save(user);

		await this.mail.sendPasswordChangeNotificationEmail(user.email, {
			userName: user.name || 'there',
		});

		return { message: this.translations.t('domains.auth.password_already_exists') };
	}

	async setPassword(userId: string, newPassword: string) {
		const user = await this.usersRepo
			.createQueryBuilder('user')
			.addSelect('user.passwordHash') // ✅ because select: false
			.where('user.id = :id', { id: userId })
			.getOne();

		if (!user) throw new NotFoundException(this.translations.t('domains.auth.user_not_found'));

		// 🚫 Prevent overriding existing password
		if (user.passwordHash) {
			throw new BadRequestException(
				this.translations.t('domains.auth.password_already_exists')
			);
		}

		// ✅ Set new password
		user.passwordHash = await bcrypt.hash(newPassword, 10);
		await this.usersRepo.save(user);

		await this.mail.sendPasswordChangeNotificationEmail(user.email, {
			userName: user.name || 'there',
		});

		return { message: this.translations.t('domains.auth.password_set') };
	}

	// Step 1: Request Email Change
	async requestEmailChange(userId: string, newEmail: string) {
		// 1. Check if the new email is already used by another account
		const emailExists = await this.usersRepo.findOne({ where: { email: newEmail } });
		if (emailExists) throw new ConflictException(this.translations.t('domains.auth.email_in_use'));

		const user = await this.usersRepo.findOne({ where: { id: userId } });
		if (!user) throw new NotFoundException(this.translations.t('domains.auth.user_not_found'));

		if (user.email === newEmail) throw new BadRequestException(this.translations.t('domains.auth.already_current_email'));

		// 2. Generate and hash OTP
		const otp = this.generateOtp(6);
		user.pendingNewEmail = newEmail;
		user.newEmailOtpCodeHash = this.hashOtp(otp);
		user.newEmailOtpExpiresAt = Date.now() + 1000 * 60 * 10; // 10 minutes
		user.newEmailOtpAttempts = 0;

		await this.usersRepo.save(user);

		// 3. Send email to the NEW email address
		await this.mail.sendEmailChangeOtpEmail(newEmail, {
			otp,
			userName: user.name || 'there',
		});

		return { message: this.translations.t('domains.auth.email_change_code_sent') };
	}

	// Step 2: Verify OTP and apply Email Change
	async verifyEmailChange(userId: string, otp: string) {

		const user = await this.usersService.getFullUser(userId)

		if (!user || !user.pendingNewEmail) {
			throw new BadRequestException(this.translations.t('domains.auth.no_pending_email_change'));
		}

		// 1. Check Expiration
		const exp = Number(user.newEmailOtpExpiresAt) || 0;
		if (!user.newEmailOtpCodeHash || Date.now() > exp) {
			throw new BadRequestException(this.translations.t('domains.auth.otp_expired'));
		}

		// 2. Handle Attempts
		user.newEmailOtpAttempts = (user.newEmailOtpAttempts || 0) + 1;
		if (user.newEmailOtpAttempts > 5) {
			user.newEmailOtpCodeHash = null;
			user.newEmailOtpExpiresAt = null;
			await this.usersRepo.save(user);
			throw new BadRequestException(this.translations.t('domains.auth.too_many_attempts'));
		}

		// 3. Verify Hash
		const isMatch = this.hashOtp(otp) === user.newEmailOtpCodeHash;
		if (!isMatch) {
			await this.usersRepo.save(user);
			throw new BadRequestException(this.translations.t('domains.auth.invalid_otp'));
		}

		// 4. Success: Apply new email and clear OTP data
		user.email = user.pendingNewEmail;
		user.pendingNewEmail = null;
		user.newEmailOtpCodeHash = null;
		user.newEmailOtpExpiresAt = null;
		user.newEmailOtpAttempts = 0;

		await this.usersRepo.save(user);

		// Return new signed token because the email (and possibly payload) has changed
		return {
			message: this.translations.t('common.email_updated'),
			...await this.sign(user),
		};
	}
}