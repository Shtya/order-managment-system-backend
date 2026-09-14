import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { RegisterDto } from "dto/auth.dto";
import {
  Company,
  OnboardingStep,
  PendingUser,
  SystemRole,
  User,
} from "entities/user.entity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthService } from "./auth.service";

vi.mock("src/users/users.service", () => ({
  UsersService: class UsersService {},
}));

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("./firebase.service", () => ({
  FirebaseService: class FirebaseService {},
}));

vi.mock("../../common/nodemailer", () => ({
  MailService: class MailService {},
}));

vi.mock("src/notifications/notification.service", () => ({
  NotificationService: class NotificationService {},
}));

vi.mock("common/translation.service", () => ({
  TranslationService: class TranslationService {},
  RequestTranslationService: class RequestTranslationService {},
}));

const VALID_PASSWORD = "correct-password";
const INVALID_CREDENTIALS_KEY = "domains.auth.invalid_credentials";
const EMAIL_ALREADY_USED = "domains.auth.email_already_used";
const ROLE_NOT_SEEDED = "domains.auth.role_not_seeded";
const COOLDOWN_WAIT = "domains.auth.cooldown_wait";
const VERIFICATION_SENT = "common.verification_code_sent";
const SESSION_NOT_FOUND = "domains.auth.verification_session_not_found";
const OTP_EXPIRED = "domains.auth.otp_expired";
const TOO_MANY_ATTEMPTS = "domains.auth.too_many_attempts";
const INVALID_OTP = "domains.auth.invalid_otp";
const NO_PENDING = "domains.auth.no_pending_email_change";
const INVALID_REQUEST = "domains.auth.invalid_request";
const OTP_VERIFICATION_REQUIRED = "domains.auth.otp_verification_required";
const GOOGLE_NO_EMAIL = "domains.auth.google_no_email";
const ACCOUNT_INACTIVE = "domains.auth.account_inactive";
const USER_NOT_FOUND = "domains.auth.user_not_found";
const INVALID_CURRENT_PASSWORD = "domains.auth.invalid_current_password";
const PASSWORD_SET = "domains.auth.password_set";
const EMAIL_IN_USE = "domains.auth.email_in_use";
const ALREADY_CURRENT_EMAIL = "domains.auth.already_current_email";
const EMAIL_CHANGE_CODE_SENT = "domains.auth.email_change_code_sent";
const OTP_CONDITIONAL_RECEIVE = "common.otp_conditional_receive";
const OTP_SENT_CONDITIONAL = "common.otp_sent_conditional";
const NEW_CODE_SENT = "common.new_code_sent";
const OTP_VERIFIED_MSG = "common.otp_verified";
const PASSWORD_UPDATED = "common.password_updated";
const EMAIL_UPDATED = "common.email_updated";
const INVALID_USER = "domains.auth.invalid_user";
const PERMISSION_DENIED = "common.permission_denied";
const VALID_OTP = "123456";

describe("AuthService", () => {
  void AuthService.prototype.login;
  describe("login", () => {
    let service: AuthService;
    let getFullUserByEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getFullUserByEmail = vi.fn();

      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { sign: vi.fn().mockReturnValue("access-token") } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUserByEmail } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws unauthorized when no user is found", async () => {
      getFullUserByEmail.mockResolvedValue(null);

      await expectLoginToRejectUnauthorized("missing@example.com", VALID_PASSWORD);
    });

    test("throws unauthorized when the user is inactive", async () => {
      getFullUserByEmail.mockResolvedValue(
        await buildUser({ isActive: false }),
      );

      await expectLoginToRejectUnauthorized("ada@example.com", VALID_PASSWORD);
    });

    test("throws unauthorized when the password does not match", async () => {
      getFullUserByEmail.mockResolvedValue(await buildUser());

      await expectLoginToRejectUnauthorized("ada@example.com", "wrong-password");
    });

    test("throws unauthorized when the user has no password hash", async () => {
      getFullUserByEmail.mockResolvedValue(
        await buildUser({ passwordHash: null }),
      );

      await expectLoginToRejectUnauthorized("ada@example.com", VALID_PASSWORD);
    });

    test("returns an access token when credentials are valid", async () => {
      getFullUserByEmail.mockResolvedValue(await buildUser());

      const result = await service.login("ada@example.com", VALID_PASSWORD);

      expect(result.accessToken).toBe("access-token");
    });

    test("returns the user without a password hash when credentials are valid", async () => {
      getFullUserByEmail.mockResolvedValue(await buildUser());

      const result = await service.login("ada@example.com", VALID_PASSWORD);

      expect(result.user).toMatchObject({
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        isActive: true,
      });
      expect(result.user).not.toHaveProperty("passwordHash");
    });

    async function expectLoginToRejectUnauthorized(
      email: string,
      password: string,
    ) {
      let thrown: unknown;
      try {
        await service.login(email, password);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(
        INVALID_CREDENTIALS_KEY,
      );
    }
  });

  void AuthService.prototype.register;
  describe("register", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let pendingFindOne: ReturnType<typeof vi.fn>;
    let pendingCreate: ReturnType<typeof vi.fn>;
    let pendingSave: ReturnType<typeof vi.fn>;
    let rolesFindOne: ReturnType<typeof vi.fn>;
    let sendRegistrationOtpEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn().mockResolvedValue(null);
      pendingFindOne = vi.fn().mockResolvedValue(null);
      pendingCreate = vi.fn((data: unknown) => ({
        id: "pending-1",
        ...(data as object),
      }));
      pendingSave = vi.fn(async (entity: unknown) => entity);
      rolesFindOne = vi.fn().mockResolvedValue({
        id: "role-1",
        name: SystemRole.ADMIN,
      });
      sendRegistrationOtpEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne } as never,
        {
          findOne: pendingFindOne,
          create: pendingCreate,
          save: pendingSave,
        } as never,
        { findOne: rolesFindOne } as never,
        {} as never,
        { sendRegistrationOtpEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws bad-request when the email is already registered", async () => {
      usersFindOne.mockResolvedValue({ id: "user-1" });

      await expectRegisterToReject(
        service,
        buildRegisterDto(),
        BadRequestException,
        EMAIL_ALREADY_USED,
      );
    });

    test("throws bad-request when the admin role is missing", async () => {
      rolesFindOne.mockResolvedValue(null);

      await expectRegisterToReject(
        service,
        buildRegisterDto(),
        BadRequestException,
        ROLE_NOT_SEEDED,
      );
    });

    test("throws forbidden when a pending OTP was sent recently", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() - 10 * 1000 }),
      );

      await expectRegisterToReject(
        service,
        buildRegisterDto(),
        ForbiddenException,
        COOLDOWN_WAIT,
      );
    });

    test("returns the registered email for a new email address", async () => {
      const result = await service.register(buildRegisterDto());

      expect(result.email).toBe("ada@example.com");
    });

    test("returns a verification-sent message for a new email address", async () => {
      const result = await service.register(buildRegisterDto());

      expect(result.message).toBe(VERIFICATION_SENT);
    });

    test("sends a six-digit OTP email for a new email address", async () => {
      await service.register(buildRegisterDto());

      expect(sendRegistrationOtpEmail).toHaveBeenCalledTimes(1);
      const [, payload] = sendRegistrationOtpEmail.mock.calls[0] as [
        string,
        { otp: string },
      ];
      expect(payload.otp).toMatch(/^\d{6}$/);
    });

    test("sends registration OTP email with recipient details for a new email address", async () => {
      const dto = buildRegisterDto();

      await service.register(dto);

      expect(sendRegistrationOtpEmail).toHaveBeenCalledTimes(1);
      const [email, payload] = sendRegistrationOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(email).toBe(dto.email);
      expect(payload.otp).toMatch(/^\d{6}$/);
      expect(payload.userName).toBe(dto.name);
    });

    test("sends fallback name when register name is missing", async () => {
      await service.register(buildRegisterDto({ name: "" }));

      const [, payload] = sendRegistrationOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("updates the existing pending record when cooldown has expired", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({
          lastSentAt: Date.now() - 61 * 1000,
          otpAttempts: 3,
        }),
      );

      const result = await service.register(buildRegisterDto());

      expect(result.email).toBe("ada@example.com");
      expect(pendingSave).toHaveBeenCalledTimes(1);
      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpAttempts).toBe(0);
    });

    test("throws forbidden when cooldown has 59 seconds elapsed", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() - 59 * 1000 }),
      );

      await expectRegisterToReject(
        service,
        buildRegisterDto(),
        ForbiddenException,
        COOLDOWN_WAIT,
      );
    });

    test("allows registration when cooldown has 60 seconds elapsed", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() - 60 * 1000 }),
      );

      const result = await service.register(buildRegisterDto());

      expect(result.email).toBe("ada@example.com");
    });

    test("reports remaining seconds in cooldown error", async () => {
      const t = vi.fn((key: string) => key);
      const cooldownService = new AuthService(
        {} as never,
        { findOne: usersFindOne } as never,
        {
          findOne: pendingFindOne,
          create: pendingCreate,
          save: pendingSave,
        } as never,
        { findOne: rolesFindOne } as never,
        {} as never,
        { sendRegistrationOtpEmail } as never,
        {} as never,
        {} as never,
        { t } as never,
        {} as never,
        {} as never,
      );
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() - 10 * 1000 }),
      );

      let thrown: unknown;
      try {
        await cooldownService.register(buildRegisterDto());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect(t).toHaveBeenCalledWith(
        COOLDOWN_WAIT,
        expect.objectContaining({
          args: expect.objectContaining({ remainingSeconds: expect.any(Number) }),
        }),
      );
    });

    test("allows registration when pending has no last sent timestamp", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: null as never }),
      );

      const result = await service.register(buildRegisterDto());

      expect(result.email).toBe("ada@example.com");
    });

    test("creates a new pending row when none exists", async () => {
      pendingFindOne.mockResolvedValue(null);

      await service.register(buildRegisterDto());

      expect(pendingCreate).toHaveBeenCalledTimes(1);
      expect(pendingSave).toHaveBeenCalledTimes(1);
    });

    test("updates pending without recreating when cooldown expired", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() - 61 * 1000 }),
      );

      await service.register(buildRegisterDto());

      expect(pendingCreate).not.toHaveBeenCalled();
      expect(pendingSave).toHaveBeenCalledTimes(1);
    });

    test("persists pending fields when registration is new", async () => {
      pendingFindOne.mockResolvedValue(null);

      await service.register(buildRegisterDto());

      const created = pendingCreate.mock.calls[0][0] as PendingUser;
      expect(created.roleId).toBe("role-1");
      expect(created.companyName).toBe("Acme");
      expect(created.businessType).toBe("retail");
      expect(created.otpExpiresAt).toBeGreaterThan(Date.now());
    });

    test("hashes the password before persisting", async () => {
      pendingFindOne.mockResolvedValue(null);
      const dto = buildRegisterDto({ password: "StrongPass1" });

      await service.register(dto);

      const created = pendingCreate.mock.calls[0][0] as PendingUser;
      expect(created.passwordHash).not.toBe("StrongPass1");
      expect(await bcrypt.compare("StrongPass1", created.passwordHash)).toBe(
        true,
      );
    });

    test("propagates mail failure when OTP email fails", async () => {
      sendRegistrationOtpEmail.mockRejectedValue(new Error("smtp down"));

      await expect(service.register(buildRegisterDto())).rejects.toThrow(
        "smtp down",
      );
    });
  });

  void AuthService.prototype.verifyRegisterOtp;
  describe("verifyRegisterOtp", () => {
    let service: AuthService;
    let pendingFindOne: ReturnType<typeof vi.fn>;
    let pendingSave: ReturnType<typeof vi.fn>;
    let transaction: ReturnType<typeof vi.fn>;
    let managerCreate: ReturnType<typeof vi.fn>;
    let managerSave: ReturnType<typeof vi.fn>;
    let managerDelete: ReturnType<typeof vi.fn>;
    let getFullUser: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      pendingFindOne = vi.fn();
      pendingSave = vi.fn(async (entity: unknown) => entity);
      managerCreate = vi.fn((_entity: unknown, data: unknown) => ({
        ...(data as object),
      }));
      managerSave = vi.fn(async (entity: unknown) => ({
        id: "new-user-id",
        ...(entity as object),
      }));
      managerDelete = vi.fn().mockResolvedValue(undefined);
      transaction = vi.fn(async (cb: (m: unknown) => unknown) =>
        cb({
          create: managerCreate,
          save: managerSave,
          delete: managerDelete,
        }),
      );
      getFullUser = vi
        .fn()
        .mockResolvedValue({ id: "new-user-id", email: "ada@example.com" });
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        { transaction } as never,
        {} as never,
        { findOne: pendingFindOne, save: pendingSave } as never,
        {} as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws bad-request when no pending registration exists", async () => {
      pendingFindOne.mockResolvedValue(null);

      await expectVerifyToReject(
        service,
        "missing@example.com",
        VALID_OTP,
        BadRequestException,
        SESSION_NOT_FOUND,
      );
    });

    test("throws expired when the stored hash is missing", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ otpCodeHash: null }),
      );

      await expectVerifyToReject(
        service,
        "ada@example.com",
        VALID_OTP,
        BadRequestException,
        OTP_EXPIRED,
      );
    });

    test("throws expired when the OTP is past expiry", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ otpExpiresAt: Date.now() - 1000 }),
      );

      await expectVerifyToReject(
        service,
        "ada@example.com",
        VALID_OTP,
        BadRequestException,
        OTP_EXPIRED,
      );
    });

    test("throws too-many-attempts when attempts exceed five", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ otpAttempts: 5 }),
      );

      await expectVerifyToReject(
        service,
        "ada@example.com",
        VALID_OTP,
        BadRequestException,
        TOO_MANY_ATTEMPTS,
      );
    });

    test("throws invalid-otp when the code does not match", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser({ otpAttempts: 0 }));

      await expectVerifyToReject(
        service,
        "ada@example.com",
        "000000",
        BadRequestException,
        INVALID_OTP,
      );
    });

    test("throws invalid-otp on the fifth attempt without locking out", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser({ otpAttempts: 4 }));

      await expectVerifyToReject(
        service,
        "ada@example.com",
        "000000",
        BadRequestException,
        INVALID_OTP,
      );
    });

    test("returns an access token when the OTP is valid", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      const result = await service.verifyRegisterOtp(
        "ada@example.com",
        VALID_OTP,
      );

      expect(result.accessToken).toBe("access-token");
    });

    test("deletes the pending record when the OTP is valid", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      expect(managerDelete).toHaveBeenCalledWith(
        PendingUser,
        "pending-1",
      );
    });

    test("creates company data when pending has a company name", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ companyName: "Acme", businessType: "retail" }),
      );

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      const companyCalls = managerCreate.mock.calls.filter(
        ([entity]) => entity === Company,
      );
      expect(companyCalls.length).toBe(1);
    });

    test("increments attempts when code does not match", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser({ otpAttempts: 0 }));

      await expectVerifyToReject(
        service,
        "ada@example.com",
        "000000",
        BadRequestException,
        INVALID_OTP,
      );

      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpAttempts).toBe(1);
    });

    test("clears OTP state when attempts exceed five", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser({ otpAttempts: 5 }));

      await expectVerifyToReject(
        service,
        "ada@example.com",
        VALID_OTP,
        BadRequestException,
        TOO_MANY_ATTEMPTS,
      );

      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpCodeHash).toBeNull();
      expect(saved.otpExpiresAt).toBeNull();
    });

    test("allows OTP just before expiry", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ otpExpiresAt: Date.now() + 5000 }),
      );

      const result = await service.verifyRegisterOtp(
        "ada@example.com",
        VALID_OTP,
      );

      expect(result.accessToken).toBe("access-token");
    });

    test("creates user with expected fields when OTP is valid", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({
          name: "Ada",
          email: "ada@example.com",
          passwordHash: "ph",
          phone: "010",
          roleId: "role-1",
        }),
      );

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      const userCalls = managerCreate.mock.calls.filter(
        ([entity]) => entity === User,
      );
      expect(userCalls.length).toBe(1);
      const [, data] = userCalls[0] as [unknown, Record<string, unknown>];
      expect(data).toMatchObject({
        name: "Ada",
        email: "ada@example.com",
        passwordHash: "ph",
        phone: "010",
        roleId: "role-1",
        adminId: null,
        isActive: true,
        otpAttempts: 0,
      });
    });

    test("skips company creation when company name is absent", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ companyName: null as never }),
      );

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      const companyCalls = managerCreate.mock.calls.filter(
        ([entity]) => entity === Company,
      );
      expect(companyCalls.length).toBe(0);
    });

    test("loads full user with the new user id when OTP is valid", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      expect(getFullUser).toHaveBeenCalledWith("new-user-id");
    });

    test("signs the full user when OTP is valid", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      await service.verifyRegisterOtp("ada@example.com", VALID_OTP);

      expect(jwtSign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "new-user-id" }),
      );
    });
  });

  void AuthService.prototype.resendRegisterOtp;
  describe("resendRegisterOtp", () => {
    let service: AuthService;
    let pendingFindOne: ReturnType<typeof vi.fn>;
    let pendingSave: ReturnType<typeof vi.fn>;
    let sendRegistrationOtpEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      pendingFindOne = vi.fn();
      pendingSave = vi.fn(async (entity: unknown) => entity);
      sendRegistrationOtpEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        {} as never,
        { findOne: pendingFindOne, save: pendingSave } as never,
        {} as never,
        {} as never,
        { sendRegistrationOtpEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws bad-request when no pending registration exists", async () => {
      pendingFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.resendRegisterOtp("missing@example.com");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });

    test("returns a verification-sent message when pending exists", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      const result = await service.resendRegisterOtp("ada@example.com");

      expect(result.message).toBe(VERIFICATION_SENT);
    });

    test("resets attempts when resending", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ otpAttempts: 4 }),
      );

      await service.resendRegisterOtp("ada@example.com");

      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpAttempts).toBe(0);
    });

    test("stores a hash of the emailed OTP when resending", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser());

      await service.resendRegisterOtp("ada@example.com");

      const [, payload] = sendRegistrationOtpEmail.mock.calls[0] as [
        string,
        { otp: string },
      ];
      expect(payload.otp).toMatch(/^\d{6}$/);
      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpCodeHash).toBe(hashOtp(payload.otp));
    });

    test("allows resend without cooldown enforcement", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: Date.now() }),
      );

      const result = await service.resendRegisterOtp("ada@example.com");

      expect(result.message).toBe(VERIFICATION_SENT);
    });

    test("refreshes expiry to ten minutes when resending", async () => {
      const before = Date.now();
      pendingFindOne.mockResolvedValue(buildPendingUser());

      await service.resendRegisterOtp("ada@example.com");

      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.otpExpiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
      expect(saved.otpExpiresAt).toBeLessThanOrEqual(Date.now() + 11 * 60 * 1000);
    });

    test("refreshes last sent timestamp when resending", async () => {
      const before = Date.now();
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ lastSentAt: before - 60 * 1000 }),
      );

      await service.resendRegisterOtp("ada@example.com");

      const saved = pendingSave.mock.calls[0][0] as PendingUser;
      expect(saved.lastSentAt).toBeGreaterThanOrEqual(before);
    });

    test("sends email to the pending address when resending", async () => {
      pendingFindOne.mockResolvedValue(
        buildPendingUser({ email: "ada@example.com" }),
      );

      await service.resendRegisterOtp("ada@example.com");

      const [email] = sendRegistrationOtpEmail.mock.calls[0] as [string];
      expect(email).toBe("ada@example.com");
    });

    test("sends fallback name when pending name is missing", async () => {
      pendingFindOne.mockResolvedValue(buildPendingUser({ name: "" }));

      await service.resendRegisterOtp("ada@example.com");

      const [, payload] = sendRegistrationOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(payload.userName).toBe("there");
    });
  });

  void AuthService.prototype.sendResetOtp;
  describe("sendResetOtp", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let sendOtpEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);
      sendOtpEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        { sendOtpEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("returns conditional message when user is missing", async () => {
      usersFindOne.mockResolvedValue(null);

      const result = await service.sendResetOtp("missing@example.com");

      expect(result.message).toBe(OTP_CONDITIONAL_RECEIVE);
    });

    test("returns sent message when user exists", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      const result = await service.sendResetOtp("ada@example.com");

      expect(result.message).toBe(OTP_SENT_CONDITIONAL);
    });

    test("sends reset OTP to the user email when user exists", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      await service.sendResetOtp("ada@example.com");

      expect(sendOtpEmail).toHaveBeenCalledTimes(1);
      const [email, payload] = sendOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(email).toBe("ada@example.com");
      expect(payload.otp).toMatch(/^\d{6}$/);
      expect(payload.userName).toBe("Ada");
    });

    test("sends fallback name when user name is missing", async () => {
      usersFindOne.mockResolvedValue(await buildUser({ name: "" }));

      await service.sendResetOtp("ada@example.com");

      const [, payload] = sendOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("resets verification state when user exists", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ otpAttempts: 3, otpVerified: true }),
      );

      await service.sendResetOtp("ada@example.com");

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpAttempts).toBe(0);
      expect(saved.otpVerified).toBe(false);
    });

    test("stores hash of the emailed OTP when user exists", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      await service.sendResetOtp("ada@example.com");

      const [, payload] = sendOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpCodeHash).toBe(hashOtp(payload.otp));
    });

    test("sets expiry ten minutes ahead when user exists", async () => {
      const before = Date.now();
      usersFindOne.mockResolvedValue(await buildUser());

      await service.sendResetOtp("ada@example.com");

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpExpiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
    });

    test("returns conditional message for empty email", async () => {
      usersFindOne.mockResolvedValue(null);

      const result = await service.sendResetOtp("");

      expect(result.message).toBe(OTP_CONDITIONAL_RECEIVE);
      expect(sendOtpEmail).not.toHaveBeenCalled();
    });
  });

  void AuthService.prototype.resendEmailChangeOtp;
  describe("resendEmailChangeOtp", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let sendEmailChangeOtpEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);
      sendEmailChangeOtpEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        { sendEmailChangeOtpEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws bad-request when user is missing", async () => {
      usersFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.resendEmailChangeOtp("user-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });

    test("throws bad-request when pending email is missing", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ pendingNewEmail: null }),
      );

      let thrown: unknown;
      try {
        await service.resendEmailChangeOtp("user-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });

    test("returns new-code message when pending exists", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ pendingNewEmail: "new@example.com" }),
      );

      const result = await service.resendEmailChangeOtp("user-1");

      expect(result.message).toBe(NEW_CODE_SENT);
    });

    test("sends change OTP to the pending address when pending exists", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ pendingNewEmail: "new@example.com" }),
      );

      await service.resendEmailChangeOtp("user-1");

      expect(sendEmailChangeOtpEmail).toHaveBeenCalledTimes(1);
      const [email, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(email).toBe("new@example.com");
      expect(payload.otp).toMatch(/^\d{6}$/);
      expect(payload.userName).toBe("Ada");
    });

    test("sends fallback name when user name is missing", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ pendingNewEmail: "new@example.com", name: "" }),
      );

      await service.resendEmailChangeOtp("user-1");

      const [, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("resets change OTP state when pending exists", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpAttempts: 4,
        }),
      );

      await service.resendEmailChangeOtp("user-1");

      const [, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.newEmailOtpAttempts).toBe(0);
      expect(saved.newEmailOtpCodeHash).toBe(hashOtp(payload.otp));
      expect(saved.newEmailOtpExpiresAt).toBeGreaterThan(Date.now());
    });

    test("throws bad-request when pending email is empty", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ pendingNewEmail: "" }),
      );

      let thrown: unknown;
      try {
        await service.resendEmailChangeOtp("user-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });
  });

  void AuthService.prototype.verifyResetOtp;
  describe("verifyResetOtp", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws invalid-request when user is missing", async () => {
      usersFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.verifyResetOtp("missing@example.com", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_REQUEST);
    });

    test("throws expired when stored hash is missing", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: null,
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(OTP_EXPIRED);
    });

    test("throws expired when OTP is past expiry", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() - 1000,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(OTP_EXPIRED);
    });

    test("throws too-many-attempts when attempts exceed five", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 5,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(TOO_MANY_ATTEMPTS);
    });

    test("throws invalid-otp when code does not match", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 0,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", "000000");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_OTP);
    });

    test("marks OTP verified when code is valid", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 0,
        }),
      );

      const result = await service.verifyResetOtp("ada@example.com", VALID_OTP);

      expect(result.message).toBe(OTP_VERIFIED_MSG);
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpVerified).toBe(true);
    });

    test("throws invalid-otp on the fourth attempt without locking out", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 4,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", "000000");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_OTP);
    });

    test("clears OTP state when attempts exceed five", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 5,
        }),
      );

      try {
        await service.verifyResetOtp("ada@example.com", VALID_OTP);
      } catch {
        // expected
      }

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpCodeHash).toBeNull();
      expect(saved.otpExpiresAt).toBeNull();
      expect(saved.otpVerified).toBe(false);
    });

    test("persists incremented attempts when code does not match", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpAttempts: 0,
        }),
      );

      try {
        await service.verifyResetOtp("ada@example.com", "000000");
      } catch {
        // expected
      }

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpAttempts).toBe(1);
    });

    test("throws expired when expiry equals now", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now(),
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyResetOtp("ada@example.com", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(OTP_EXPIRED);
    });
  });

  void AuthService.prototype.resetPasswordByOtp;
  describe("resetPasswordByOtp", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let getFullUser: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);
      getFullUser = vi
        .fn()
        .mockResolvedValue({ id: "user-1", email: "ada@example.com" });
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws invalid-request when user is missing", async () => {
      usersFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.resetPasswordByOtp("missing@example.com", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_REQUEST);
    });

    test("throws verification-required when OTP is not verified", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: false,
        }),
      );

      let thrown: unknown;
      try {
        await service.resetPasswordByOtp("ada@example.com", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        OTP_VERIFICATION_REQUIRED,
      );
    });

    test("throws verification-required when OTP is expired", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() - 1000,
          otpVerified: true,
        }),
      );

      let thrown: unknown;
      try {
        await service.resetPasswordByOtp("ada@example.com", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        OTP_VERIFICATION_REQUIRED,
      );
    });

    test("returns updated message with access token when OTP is verified", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
        }),
      );

      const result = await service.resetPasswordByOtp(
        "ada@example.com",
        "NewPass1A",
      );

      expect(result.message).toBe(PASSWORD_UPDATED);
      expect(result.accessToken).toBe("access-token");
    });

    test("throws verification-required when hash is missing", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          otpCodeHash: null,
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
        }),
      );

      let thrown: unknown;
      try {
        await service.resetPasswordByOtp("ada@example.com", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        OTP_VERIFICATION_REQUIRED,
      );
    });

    test("hashes the new password when OTP is verified", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
        }),
      );

      await service.resetPasswordByOtp("ada@example.com", "NewPass1A");

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.passwordHash).not.toBe("NewPass1A");
      expect(await bcrypt.compare("NewPass1A", saved.passwordHash as string)).toBe(
        true,
      );
    });

    test("clears OTP state when password is reset", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
          otpAttempts: 2,
        }),
      );

      await service.resetPasswordByOtp("ada@example.com", "NewPass1A");

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.otpCodeHash).toBeNull();
      expect(saved.otpExpiresAt).toBeNull();
      expect(saved.otpVerified).toBe(false);
      expect(saved.otpAttempts).toBe(0);
    });

    test("propagates missing full user after password reset", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
        }),
      );
      getFullUser.mockResolvedValue(null);

      await expect(
        service.resetPasswordByOtp("ada@example.com", "NewPass1A"),
      ).rejects.toThrow();
    });

    test("omits password hash from the signed user", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          otpCodeHash: hashOtp(VALID_OTP),
          otpExpiresAt: Date.now() + 10 * 60 * 1000,
          otpVerified: true,
        }),
      );
      getFullUser.mockResolvedValue(
        await buildUser({ id: "user-1", passwordHash: "secret" }),
      );

      const result = await service.resetPasswordByOtp(
        "ada@example.com",
        "NewPass1A",
      );

      expect(result.user).not.toHaveProperty("passwordHash");
    });
  });

  void AuthService.prototype.googleLogin;
  describe("googleLogin", () => {
    let service: AuthService;
    let verifyIdToken: ReturnType<typeof vi.fn>;
    let getFullUserByEmail: ReturnType<typeof vi.fn>;
    let getFullUser: ReturnType<typeof vi.fn>;
    let rolesFindOne: ReturnType<typeof vi.fn>;
    let usersCreate: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      verifyIdToken = vi
        .fn()
        .mockResolvedValue({ email: "ada@example.com", name: "Ada" });
      getFullUserByEmail = vi.fn();
      getFullUser = vi.fn().mockResolvedValue({
        id: "new-user-id",
        email: "ada@example.com",
        isActive: true,
      });
      rolesFindOne = vi
        .fn()
        .mockResolvedValue({ id: "role-1", name: SystemRole.USER });
      usersCreate = vi.fn((data: unknown) => ({ ...(data as object) }));
      usersSave = vi.fn(async (entity: unknown) => entity);
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        { create: usersCreate, save: usersSave } as never,
        {} as never,
        { findOne: rolesFindOne } as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        { verifyIdToken } as never,
        { getFullUserByEmail, getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws unauthorized when token has no email", async () => {
      verifyIdToken.mockResolvedValue({});

      let thrown: unknown;
      try {
        await service.googleLogin("token");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(GOOGLE_NO_EMAIL);
    });

    test("throws unauthorized when user is inactive", async () => {
      getFullUserByEmail.mockResolvedValue(
        await buildUser({ isActive: false }),
      );

      let thrown: unknown;
      try {
        await service.googleLogin("token");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(
        ACCOUNT_INACTIVE,
      );
    });

    test("throws bad-request when role is missing for a new user", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      rolesFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.googleLogin("token");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(ROLE_NOT_SEEDED);
    });

    test("returns an access token for an existing active user", async () => {
      getFullUserByEmail.mockResolvedValue(await buildUser());

      const result = await service.googleLogin("token");

      expect(result.accessToken).toBe("access-token");
    });

    test("creates a user with fallback name when email is new", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      verifyIdToken.mockResolvedValue({ email: "new@example.com" });

      const result = await service.googleLogin("token", "Fallback");

      expect(usersCreate).toHaveBeenCalledTimes(1);
      const created = usersCreate.mock.calls[0][0] as User;
      expect(created.name).toBe("Fallback");
      expect(result.accessToken).toBe("access-token");
    });

    test("creates a user with translated fallback name when decoded name is missing", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      verifyIdToken.mockResolvedValue({ email: "new@example.com" });

      await service.googleLogin("token");

      const created = usersCreate.mock.calls[0][0] as User;
      expect(created.name).toBe("domains.auth.fallback_google_user");
    });

    test("prefers decoded name over fallback name", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      verifyIdToken.mockResolvedValue({
        email: "new@example.com",
        name: "Decoded",
      });

      await service.googleLogin("token", "Fallback");

      const created = usersCreate.mock.calls[0][0] as User;
      expect(created.name).toBe("Decoded");
    });

    test("creates a new user with expected defaults", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      verifyIdToken.mockResolvedValue({
        email: "new@example.com",
        name: "Ada",
      });

      await service.googleLogin("token");

      const created = usersCreate.mock.calls[0][0] as User;
      expect(created).toMatchObject({
        email: "new@example.com",
        roleId: "role-1",
        passwordHash: null,
        adminId: null,
        isActive: true,
        otpAttempts: 0,
      });
    });

    test("loads full user after creating", async () => {
      getFullUserByEmail.mockResolvedValue(null);
      verifyIdToken.mockResolvedValue({
        email: "new@example.com",
        name: "Ada",
      });
      usersCreate.mockReturnValue({ id: "created-id" });

      await service.googleLogin("token");

      expect(getFullUser).toHaveBeenCalledWith("created-id");
    });

    test("propagates token verification failure", async () => {
      verifyIdToken.mockRejectedValue(new Error("bad token"));

      await expect(service.googleLogin("bad")).rejects.toThrow("bad token");
    });

    test("throws unauthorized when email is empty", async () => {
      verifyIdToken.mockResolvedValue({ email: "" });

      let thrown: unknown;
      try {
        await service.googleLogin("token");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(GOOGLE_NO_EMAIL);
    });
  });

  void AuthService.prototype.handleGoogleCallback;
  describe("handleGoogleCallback", () => {
    let service: AuthService;
    let createQueryBuilder: ReturnType<typeof vi.fn>;
    let getOne: ReturnType<typeof vi.fn>;
    let rolesFindOne: ReturnType<typeof vi.fn>;
    let usersCreate: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let getFullUser: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getOne = vi.fn();
      const qb = {
        leftJoinAndSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getOne,
      };
      createQueryBuilder = vi.fn().mockReturnValue(qb);
      rolesFindOne = vi
        .fn()
        .mockResolvedValue({ id: "role-1", name: SystemRole.ADMIN });
      usersCreate = vi.fn((data: unknown) => ({ ...(data as object) }));
      usersSave = vi.fn(async (entity: unknown) => entity);
      getFullUser = vi.fn().mockResolvedValue({
        id: "new-user-id",
        email: "ada@example.com",
        isActive: true,
      });
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        {
          createQueryBuilder,
          create: usersCreate,
          save: usersSave,
        } as never,
        {} as never,
        { findOne: rolesFindOne } as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws unauthorized when profile has no email", async () => {
      let thrown: unknown;
      try {
        await service.handleGoogleCallback({ id: "g-1", name: "Ada" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(GOOGLE_NO_EMAIL);
    });

    test("throws bad-request when role is missing for a new profile", async () => {
      getOne.mockResolvedValue(null);
      rolesFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.handleGoogleCallback({
          id: "g-1",
          email: "new@example.com",
          name: "Ada",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(ROLE_NOT_SEEDED);
    });

    test("throws unauthorized when user is inactive", async () => {
      getOne.mockResolvedValue(await buildUser({ isActive: false }));

      let thrown: unknown;
      try {
        await service.handleGoogleCallback({
          id: "g-1",
          email: "ada@example.com",
          name: "Ada",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(
        ACCOUNT_INACTIVE,
      );
    });

    test("returns redirect path from state when user exists", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback(
        { id: "g-1", email: "ada@example.com", name: "Ada" },
        JSON.stringify({ redirectPath: "/dashboard" }),
      );

      expect(result.accessToken).toBe("access-token");
      expect(result.redirectPath).toBe("/dashboard");
    });

    test("creates a user when email is unknown", async () => {
      getOne.mockResolvedValue(null);

      const result = await service.handleGoogleCallback({
        id: "g-1",
        email: "new@example.com",
        name: "Ada",
      });

      expect(usersCreate).toHaveBeenCalledTimes(1);
      expect(result.redirectPath).toBe("/");
    });

    test("creates a user with empty name when profile name is missing", async () => {
      getOne.mockResolvedValue(null);

      await service.handleGoogleCallback({
        id: "g-1",
        email: "new@example.com",
      });

      const created = usersCreate.mock.calls[0][0] as User;
      expect(created.name).toBe("");
    });

    test("returns root path when state is invalid", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback(
        { id: "g-1", email: "ada@example.com", name: "Ada" },
        "not-json",
      );

      expect(result.redirectPath).toBe("/");
    });

    test("returns root path when state has no redirect path", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback(
        { id: "g-1", email: "ada@example.com", name: "Ada" },
        JSON.stringify({}),
      );

      expect(result.redirectPath).toBe("/");
    });

    test("returns root path when state is undefined", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback({
        id: "g-1",
        email: "ada@example.com",
        name: "Ada",
      });

      expect(result.redirectPath).toBe("/");
    });

    test("returns root path when state is null literal", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback(
        { id: "g-1", email: "ada@example.com", name: "Ada" },
        "null",
      );

      expect(result.redirectPath).toBe("/");
    });

    test("creates a new user with admin defaults", async () => {
      getOne.mockResolvedValue(null);

      await service.handleGoogleCallback({
        id: "g-1",
        email: "new@example.com",
        name: "Ada",
      });

      const created = usersCreate.mock.calls[0][0] as User;
      expect(created).toMatchObject({
        email: "new@example.com",
        roleId: "role-1",
        googleId: "g-1",
        passwordHash: null,
        adminId: null,
        isActive: true,
      });
    });

    test("loads full user after creating", async () => {
      getOne.mockResolvedValue(null);
      usersCreate.mockReturnValue({ id: "created-id" });

      await service.handleGoogleCallback({
        id: "g-1",
        email: "new@example.com",
        name: "Ada",
      });

      expect(getFullUser).toHaveBeenCalledWith("created-id");
    });

    test("returns root path when redirect path is empty", async () => {
      getOne.mockResolvedValue(await buildUser());

      const result = await service.handleGoogleCallback(
        { id: "g-1", email: "ada@example.com", name: "Ada" },
        JSON.stringify({ redirectPath: "" }),
      );

      expect(result.redirectPath).toBe("/");
    });
  });

  void AuthService.prototype.signUser;
  describe("signUser", () => {
    let service: AuthService;
    let getFullUser: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getFullUser = vi.fn();
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws not-found when user is missing", async () => {
      getFullUser.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.signUser("missing-id");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(USER_NOT_FOUND);
    });

    test("returns an access token when user exists", async () => {
      getFullUser.mockResolvedValue(await buildUser());

      const result = await service.signUser("user-1");

      expect(result.accessToken).toBe("access-token");
    });

    test("returns the signed user when user exists", async () => {
      getFullUser.mockResolvedValue(await buildUser());

      const result = await service.signUser("user-1");

      expect(result.user).toMatchObject({ id: "user-1" });
    });

    test("encodes onboarding state in JWT payload", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({ currentOnboardingStep: OnboardingStep.PLAN }),
      );

      await service.signUser("user-1");

      expect(jwtSign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "user-1", isOnboarding: true }),
      );
    });

    test("removes the password hash from the signed user", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({ passwordHash: "secret" }),
      );
    
      const result = await service.signUser("user-1");
    
      expect(result.user).not.toHaveProperty("passwordHash");
    });
  });

  void AuthService.prototype.changePasswordByOldPassword;
  describe("changePasswordByOldPassword", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let sendPasswordChangeNotificationEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);
      sendPasswordChangeNotificationEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        { sendPasswordChangeNotificationEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws not-found when user is missing", async () => {
      usersFindOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.changePasswordByOldPassword(
          "missing-id",
          VALID_PASSWORD,
          "NewPass1A",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(USER_NOT_FOUND);
    });

    test("throws bad-request when old password mismatches", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      let thrown: unknown;
      try {
        await service.changePasswordByOldPassword(
          "user-1",
          "wrong-password",
          "NewPass1A",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        INVALID_CURRENT_PASSWORD,
      );
    });

    test("returns confirmation message when old password is valid", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      const result = await service.changePasswordByOldPassword(
        "user-1",
        VALID_PASSWORD,
        "NewPass1A",
      );

      expect(result.message).toBe("domains.auth.password_already_exists");
    });

    test("sends notification email when old password is valid", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      await service.changePasswordByOldPassword(
        "user-1",
        VALID_PASSWORD,
        "NewPass1A",
      );

      expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledTimes(1);
      const [email, payload] =
        sendPasswordChangeNotificationEmail.mock.calls[0] as [
          string,
          { userName: string },
        ];
      expect(email).toBe("ada@example.com");
      expect(payload.userName).toBe("Ada");
    });

    test("sends fallback name when user name is missing", async () => {
      usersFindOne.mockResolvedValue(await buildUser({ name: "" }));

      await service.changePasswordByOldPassword(
        "user-1",
        VALID_PASSWORD,
        "NewPass1A",
      );

      const [, payload] = sendPasswordChangeNotificationEmail.mock.calls[0] as [
        string,
        { userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("hashes the new password when old password is valid", async () => {
      usersFindOne.mockResolvedValue(await buildUser());

      await service.changePasswordByOldPassword(
        "user-1",
        VALID_PASSWORD,
        "NewPass1A",
      );

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.passwordHash).not.toBe("NewPass1A");
      expect(await bcrypt.compare("NewPass1A", saved.passwordHash as string)).toBe(
        true,
      );
    });

    test("throws bad-request when stored hash is missing", async () => {
      usersFindOne.mockResolvedValue(
        await buildUser({ passwordHash: null }),
      );

      let thrown: unknown;
      try {
        await service.changePasswordByOldPassword(
          "user-1",
          VALID_PASSWORD,
          "NewPass1A",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        INVALID_CURRENT_PASSWORD,
      );
    });
  });

  void AuthService.prototype.setPassword;
  describe("setPassword", () => {
    let service: AuthService;
    let createQueryBuilder: ReturnType<typeof vi.fn>;
    let getOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let sendPasswordChangeNotificationEmail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getOne = vi.fn();
      const qb = {
        addSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getOne,
      };
      createQueryBuilder = vi.fn().mockReturnValue(qb);
      usersSave = vi.fn(async (entity: unknown) => entity);
      sendPasswordChangeNotificationEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { createQueryBuilder, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        { sendPasswordChangeNotificationEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws not-found when user is missing", async () => {
      getOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.setPassword("missing-id", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(USER_NOT_FOUND);
    });

    test("throws bad-request when password already exists", async () => {
      getOne.mockResolvedValue(await buildUser());

      let thrown: unknown;
      try {
        await service.setPassword("user-1", "NewPass1A");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        "domains.auth.password_already_exists",
      );
    });

    test("returns password-set message when no password exists", async () => {
      getOne.mockResolvedValue(
        await buildUser({ passwordHash: null }),
      );

      const result = await service.setPassword("user-1", "NewPass1A");

      expect(result.message).toBe(PASSWORD_SET);
    });

    test("sends notification email when password is set", async () => {
      getOne.mockResolvedValue(
        await buildUser({ passwordHash: null }),
      );

      await service.setPassword("user-1", "NewPass1A");

      expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledTimes(1);
      const [email, payload] = sendPasswordChangeNotificationEmail.mock
        .calls[0] as [string, { userName: string }];
      expect(email).toBe("ada@example.com");
      expect(payload.userName).toBe("Ada");
    });

    test("sends fallback name when user name is missing", async () => {
      getOne.mockResolvedValue(
        await buildUser({ passwordHash: null, name: "" }),
      );

      await service.setPassword("user-1", "NewPass1A");

      const [, payload] = sendPasswordChangeNotificationEmail.mock.calls[0] as [
        string,
        { userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("allows setting when stored hash is empty", async () => {
      getOne.mockResolvedValue(await buildUser({ passwordHash: "" }));

      const result = await service.setPassword("user-1", "NewPass1A");

      expect(result.message).toBe(PASSWORD_SET);
    });

    test("hashes the new password when setting", async () => {
      getOne.mockResolvedValue(
        await buildUser({ passwordHash: null }),
      );

      await service.setPassword("user-1", "NewPass1A");

      const saved = usersSave.mock.calls[0][0] as User;
      expect(await bcrypt.compare("NewPass1A", saved.passwordHash as string)).toBe(
        true,
      );
    });
  });

  void AuthService.prototype.requestEmailChange;
  describe("requestEmailChange", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let sendEmailChangeOtpEmail: ReturnType<typeof vi.fn>;
    let emailLookup: unknown;
    let idLookup: unknown;

    beforeEach(() => {
      emailLookup = null;
      idLookup = null;
      usersFindOne = vi.fn(async (options: { where?: { email?: string } }) =>
        options?.where?.email ? emailLookup : idLookup,
      );
      usersSave = vi.fn(async (entity: unknown) => entity);
      sendEmailChangeOtpEmail = vi.fn().mockResolvedValue(undefined);

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne, save: usersSave } as never,
        {} as never,
        {} as never,
        {} as never,
        { sendEmailChangeOtpEmail } as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws conflict when new email is taken", async () => {
      emailLookup = { id: "other-id" };
      idLookup = await buildUser();

      let thrown: unknown;
      try {
        await service.requestEmailChange("user-1", "taken@example.com");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).message).toBe(EMAIL_IN_USE);
    });

    test("throws not-found when user is missing", async () => {
      emailLookup = null;
      idLookup = null;

      let thrown: unknown;
      try {
        await service.requestEmailChange("missing-id", "new@example.com");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(USER_NOT_FOUND);
    });

    test("throws bad-request when new email equals current", async () => {
      emailLookup = null;
      idLookup = await buildUser({ email: "ada@example.com" });

      let thrown: unknown;
      try {
        await service.requestEmailChange("user-1", "ada@example.com");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(
        ALREADY_CURRENT_EMAIL,
      );
    });

    test("returns code-sent message when request is valid", async () => {
      emailLookup = null;
      idLookup = await buildUser();

      const result = await service.requestEmailChange(
        "user-1",
        "new@example.com",
      );

      expect(result.message).toBe(EMAIL_CHANGE_CODE_SENT);
    });

    test("sends change OTP to the new email when request is valid", async () => {
      emailLookup = null;
      idLookup = await buildUser();

      await service.requestEmailChange("user-1", "new@example.com");

      expect(sendEmailChangeOtpEmail).toHaveBeenCalledTimes(1);
      const [email, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(email).toBe("new@example.com");
      expect(payload.otp).toMatch(/^\d{6}$/);
      expect(payload.userName).toBe("Ada");
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.pendingNewEmail).toBe("new@example.com");
    });

    test("sends fallback name when user name is missing", async () => {
      emailLookup = null;
      idLookup = await buildUser({ name: "" });

      await service.requestEmailChange("user-1", "new@example.com");

      const [, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      expect(payload.userName).toBe("there");
    });

    test("checks email conflict before user lookup", async () => {
      emailLookup = { id: "other-id" };
      idLookup = null;

      let thrown: unknown;
      try {
        await service.requestEmailChange("missing-id", "taken@example.com");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).message).toBe(EMAIL_IN_USE);
    });

    test("resets change OTP state when request is valid", async () => {
      emailLookup = null;
      idLookup = await buildUser({ newEmailOtpAttempts: 4 });

      await service.requestEmailChange("user-1", "new@example.com");

      const [, payload] = sendEmailChangeOtpEmail.mock.calls[0] as [
        string,
        { otp: string; userName: string },
      ];
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.pendingNewEmail).toBe("new@example.com");
      expect(saved.newEmailOtpCodeHash).toBe(hashOtp(payload.otp));
      expect(saved.newEmailOtpExpiresAt).toBeGreaterThan(Date.now());
      expect(saved.newEmailOtpAttempts).toBe(0);
    });
  });

  void AuthService.prototype.verifyEmailChange;
  describe("verifyEmailChange", () => {
    let service: AuthService;
    let getFullUser: ReturnType<typeof vi.fn>;
    let usersSave: ReturnType<typeof vi.fn>;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getFullUser = vi.fn();
      usersSave = vi.fn(async (entity: unknown) => entity);
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        { save: usersSave } as never,
        {} as never,
        {} as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws bad-request when user is missing", async () => {
      getFullUser.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });

    test("throws bad-request when pending email is missing", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({ pendingNewEmail: null }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(NO_PENDING);
    });

    test("throws expired when OTP is past expiry", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() - 1000,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(OTP_EXPIRED);
    });

    test("throws too-many-attempts when attempts exceed five", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 5,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(TOO_MANY_ATTEMPTS);
    });

    test("throws invalid-otp when code does not match", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 0,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", "000000");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_OTP);
    });

    test("applies the new email with access token when code is valid", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 0,
        }),
      );

      const result = await service.verifyEmailChange("user-1", VALID_OTP);

      expect(result.message).toBe(EMAIL_UPDATED);
      expect(result.accessToken).toBe("access-token");
      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.email).toBe("new@example.com");
    });

    test("throws expired when hash is missing", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: null,
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(OTP_EXPIRED);
    });

    test("throws invalid-otp on the fourth attempt without locking out", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 4,
        }),
      );

      let thrown: unknown;
      try {
        await service.verifyEmailChange("user-1", "000000");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toBe(INVALID_OTP);
    });

    test("clears OTP state when attempts exceed five", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 5,
        }),
      );

      try {
        await service.verifyEmailChange("user-1", VALID_OTP);
      } catch {
        // expected
      }

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.newEmailOtpCodeHash).toBeNull();
      expect(saved.newEmailOtpExpiresAt).toBeNull();
    });

    test("persists incremented attempts when code does not match", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 0,
        }),
      );

      try {
        await service.verifyEmailChange("user-1", "000000");
      } catch {
        // expected
      }

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.newEmailOtpAttempts).toBe(1);
    });

    test("clears pending state when code is valid", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          pendingNewEmail: "new@example.com",
          newEmailOtpCodeHash: hashOtp(VALID_OTP),
          newEmailOtpExpiresAt: Date.now() + 10 * 60 * 1000,
          newEmailOtpAttempts: 2,
        }),
      );

      await service.verifyEmailChange("user-1", VALID_OTP);

      const saved = usersSave.mock.calls[0][0] as User;
      expect(saved.pendingNewEmail).toBeNull();
      expect(saved.newEmailOtpCodeHash).toBeNull();
      expect(saved.newEmailOtpExpiresAt).toBeNull();
      expect(saved.newEmailOtpAttempts).toBe(0);
    });
  });

  void AuthService.prototype.createOAuthState;
  describe("createOAuthState", () => {
    let service: AuthService;

    beforeEach(() => {
      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    test("encodes the redirect path as JSON", () => {
      const result = service.createOAuthState("/dashboard");

      expect(JSON.parse(result)).toEqual({ redirectPath: "/dashboard" });
    });

    test("preserves a nested redirect path", () => {
      const result = service.createOAuthState("/orders/123?tab=items");

      expect(JSON.parse(result).redirectPath).toBe("/orders/123?tab=items");
    });
  });

  void AuthService.prototype.superAdminLogin;
  describe("superAdminLogin", () => {
    let service: AuthService;
    let getFullUser: ReturnType<typeof vi.fn>;
    let getFullUserByEmail: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      getFullUser = vi.fn().mockResolvedValue(
        await buildUser({
          id: "super-1",
          role: { name: SystemRole.SUPER_ADMIN } as never,
        }),
      );
      getFullUserByEmail = vi.fn().mockResolvedValue(
        await buildUser({
          id: "user-1",
          role: { name: SystemRole.ADMIN } as never,
        }),
      );

      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { sign: vi.fn().mockReturnValue("access-token") } as unknown as JwtService,
        {} as never,
        {} as never,
        { getFullUser, getFullUserByEmail } as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws unauthorized when super admin is missing", async () => {
      getFullUser.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.superAdminLogin("ada@example.com", "missing-id");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(PERMISSION_DENIED);
    });

    test("throws unauthorized when super admin is inactive", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          id: "super-1",
          isActive: false,
          role: { name: SystemRole.SUPER_ADMIN } as never,
        }),
      );

      let thrown: unknown;
      try {
        await service.superAdminLogin("ada@example.com", "super-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(PERMISSION_DENIED);
    });

    test("throws unauthorized when actor is not super admin", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({
          id: "user-2",
          role: { name: SystemRole.ADMIN } as never,
        }),
      );

      let thrown: unknown;
      try {
        await service.superAdminLogin("ada@example.com", "user-2");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(PERMISSION_DENIED);
    });

    test("throws unauthorized when actor role is missing", async () => {
      getFullUser.mockResolvedValue(
        await buildUser({ id: "user-2", role: null as never }),
      );

      let thrown: unknown;
      try {
        await service.superAdminLogin("ada@example.com", "user-2");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(PERMISSION_DENIED);
    });

    test("throws unauthorized when target user is missing", async () => {
      getFullUserByEmail.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.superAdminLogin("missing@example.com", "super-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(INVALID_USER);
    });

    test("throws unauthorized when target user is inactive", async () => {
      getFullUserByEmail.mockResolvedValue(
        await buildUser({ isActive: false }),
      );

      let thrown: unknown;
      try {
        await service.superAdminLogin("ada@example.com", "super-1");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(INVALID_USER);
    });

    test("returns an access token for the target user", async () => {
      const result = await service.superAdminLogin("ada@example.com", "super-1");

      expect(result.accessToken).toBe("access-token");
    });

    test("signs in as the target instead of the actor", async () => {
      const result = await service.superAdminLogin("ada@example.com", "super-1");

      expect(result.user).toMatchObject({ id: "user-1" });
      expect(result.user).not.toHaveProperty("passwordHash");
    });
  });

  void AuthService.prototype.isEmailExists;
  describe("isEmailExists", () => {
    let service: AuthService;
    let usersFindOne: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      usersFindOne = vi.fn();

      service = new AuthService(
        {} as never,
        { findOne: usersFindOne } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("returns false when no user is found", async () => {
      usersFindOne.mockResolvedValue(null);

      expect(await service.isEmailExists("missing@example.com")).toBe(false);
    });

    test("returns true when a user is found", async () => {
      usersFindOne.mockResolvedValue({ id: "user-1" });

      expect(await service.isEmailExists("ada@example.com")).toBe(true);
    });

    test("normalizes email before lookup", async () => {
      usersFindOne.mockResolvedValue(null);

      await service.isEmailExists("  ADA@Example.COM ");

      expect(usersFindOne).toHaveBeenCalledWith({
        where: { email: "ada@example.com" },
      });
    });

    test("returns false for empty email", async () => {
      usersFindOne.mockResolvedValue(null);

      expect(await service.isEmailExists("")).toBe(false);
    });

    test("returns false for whitespace email", async () => {
      usersFindOne.mockResolvedValue(null);

      expect(await service.isEmailExists("   ")).toBe(false);
      expect(usersFindOne).toHaveBeenCalledWith({ where: { email: "" } });
    });
  });

  void AuthService.prototype.validatePayload;
  describe("validatePayload", () => {
    let service: AuthService;
    let createQueryBuilder: ReturnType<typeof vi.fn>;
    let getOne: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getOne = vi.fn();
      const qb = {
        leftJoinAndSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getOne,
      };
      createQueryBuilder = vi.fn().mockReturnValue(qb);

      service = new AuthService(
        {} as never,
        { createQueryBuilder } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { t: vi.fn((key: string) => key) } as never,
        {} as never,
        {} as never,
      );
    });

    test("throws unauthorized when no user is found", async () => {
      getOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await service.validatePayload({ sub: 1 });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(INVALID_USER);
    });

    test("throws unauthorized when the user is inactive", async () => {
      getOne.mockResolvedValue(await buildUser({ isActive: false }));

      let thrown: unknown;
      try {
        await service.validatePayload({ sub: 1 });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).message).toBe(INVALID_USER);
    });

    test("returns own subscription when requester is admin", async () => {
      const ownSub = { id: "sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.ADMIN } as never,
          subscriptions: [ownSub] as never,
          admin: null as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([ownSub]);
    });

    test("uses admin subscription when requester is a member", async () => {
      const adminSub = { id: "admin-sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.USER } as never,
          subscriptions: [] as never,
          admin: { subscriptions: [adminSub] } as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([adminSub]);
    });

    test("clears subscriptions when no effective subscription exists", async () => {
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.USER } as never,
          subscriptions: [] as never,
          admin: { subscriptions: [] } as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([]);
    });

    test("removes admin reference from the result", async () => {
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.USER } as never,
          subscriptions: [] as never,
          admin: { subscriptions: [] } as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result).not.toHaveProperty("admin");
    });

    test("uses own subscription when role is missing", async () => {
      const ownSub = { id: "sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: null as never,
          subscriptions: [ownSub] as never,
          admin: null as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([ownSub]);
    });

    test("uses own subscription for non-admin without admin", async () => {
      const ownSub = { id: "sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.USER } as never,
          subscriptions: [ownSub] as never,
          admin: null as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([ownSub]);
    });

    test("prefers own subscription for admin with admin object", async () => {
      const ownSub = { id: "sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.ADMIN } as never,
          subscriptions: [ownSub] as never,
          admin: { subscriptions: [{ id: "admin-sub" }] } as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([ownSub]);
    });

    test("picks the first subscription when multiple exist", async () => {
      const first = { id: "sub-1" };
      getOne.mockResolvedValue(
        await buildUser({
          role: { name: SystemRole.ADMIN } as never,
          subscriptions: [first, { id: "sub-2" }] as never,
          admin: null as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result.subscriptions).toEqual([first]);
    });

    test("preserves user fields in the result", async () => {
      getOne.mockResolvedValue(
        await buildUser({
          id: "user-1",
          email: "ada@example.com",
          role: { name: SystemRole.ADMIN } as never,
          subscriptions: [] as never,
          admin: null as never,
        }),
      );

      const result = await service.validatePayload({ sub: 1 });

      expect(result).toMatchObject({ id: "user-1", email: "ada@example.com" });
    });
  });

  void AuthService.prototype.sign;
  describe("sign", () => {
    let service: AuthService;
    let jwtSign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      jwtSign = vi.fn().mockReturnValue("access-token");

      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { sign: jwtSign } as unknown as JwtService,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    test("includes user id as sub in JWT payload", async () => {
      await service.sign(await buildUser({ id: "user-9" }));

      expect(jwtSign).toHaveBeenCalledTimes(1);
      expect(jwtSign.mock.calls[0][0]).toMatchObject({ sub: "user-9" });
    });

    test("marks onboarding finished when step is finished", async () => {
      await service.sign(
        await buildUser({ currentOnboardingStep: OnboardingStep.FINISHED }),
      );

      expect(jwtSign.mock.calls[0][0]).toMatchObject({ isOnboarding: false });
    });

    test("marks onboarding open when step is not finished", async () => {
      await service.sign(
        await buildUser({ currentOnboardingStep: OnboardingStep.PLAN }),
      );

      expect(jwtSign.mock.calls[0][0]).toMatchObject({ isOnboarding: true });
    });

    test("returns the user without a password hash", async () => {
      const user = await buildUser();
    
      const result = await service.sign(user);
    
      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.user).toMatchObject({
        id: user.id,
        email: user.email,
        name: user.name,
      });
      expect(result.accessToken).toBe("access-token");
    });
    test("handles missing onboarding step", async () => {
      const user = await buildUser();
      delete (user as Partial<User>).currentOnboardingStep;

      const result = await service.sign(user);

      expect(jwtSign.mock.calls[0][0]).toMatchObject({ isOnboarding: true });
      expect(result.accessToken).toBe("access-token");
    });
  });

  void AuthService.prototype.parseOAuthState;
  describe("parseOAuthState", () => {
    let service: AuthService;

    beforeEach(() => {
      service = new AuthService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    test("parses valid JSON with referral details", () => {
      const result = service.parseOAuthState(
        JSON.stringify({
          redirectPath: "/dashboard",
          referralCode: "REF1",
          type: "admin",
        }),
      );

      expect(result).toEqual({
        redirectPath: "/dashboard",
        referralCode: "REF1",
        type: "admin",
      });
    });

    test("returns root path when state is undefined", () => {
      expect(service.parseOAuthState(undefined as never)).toEqual({
        redirectPath: "/",
      });
    });

    test("returns null when state is null literal", () => {
      expect(service.parseOAuthState("null")).toBeNull();
    });

    test("returns primitive when state is a number literal", () => {
      expect(service.parseOAuthState("123")).toBe(123);
    });

    test("preserves payload when redirect path is missing", () => {
      expect(service.parseOAuthState(JSON.stringify({}))).toEqual({});
    });
  });
});

async function buildUser(overrides: Partial<User> = {}): Promise<User> {
  const passwordHash =
    "passwordHash" in overrides
      ? overrides.passwordHash
      : await bcrypt.hash(VALID_PASSWORD, 4);

  return {
    id: "user-1",
    name: "Ada",
    email: "ada@example.com",
    isActive: true,
    currentOnboardingStep: OnboardingStep.FINISHED,
    ...overrides,
    passwordHash,
  } as User;
}

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function buildRegisterDto(overrides: Partial<RegisterDto> = {}): RegisterDto {
  return {
    name: "Ada",
    email: "ada@example.com",
    password: "StrongPass1",
    phone: "01000000000",
    companyName: "Acme",
    businessType: "retail",
    ...overrides,
  };
}

function buildPendingUser(overrides: Partial<PendingUser> = {}): PendingUser {
  return {
    id: "pending-1",
    name: "Ada",
    email: "ada@example.com",
    passwordHash: "hashed-password",
    phone: "01000000000",
    companyName: "Acme",
    businessType: "retail",
    otpCodeHash: hashOtp(VALID_OTP),
    otpExpiresAt: Date.now() + 10 * 60 * 1000,
    otpAttempts: 0,
    lastSentAt: Date.now(),
    roleId: "role-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PendingUser;
}

async function expectRegisterToReject(
  service: AuthService,
  dto: RegisterDto,
  ExpectedClass: new (...args: never[]) => Error,
  expectedKey: string,
) {
  let thrown: unknown;
  try {
    await service.register(dto);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ExpectedClass);
  expect((thrown as Error).message).toBe(expectedKey);
}

async function expectVerifyToReject(
  service: AuthService,
  email: string,
  otp: string,
  ExpectedClass: new (...args: never[]) => Error,
  expectedKey: string,
) {
  let thrown: unknown;
  try {
    await service.verifyRegisterOtp(email, otp);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ExpectedClass);
  expect((thrown as Error).message).toBe(expectedKey);
}
