import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  GoogleLoginDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from 'dto/auth.dto';
import axios from 'axios';
import { Response } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { ChangePasswordDto, RequestEmailChangeDto, VerifyEmailChangeDto } from 'dto/user.dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService,

  ) { }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('verify-registration')
  async verifyRegistration(@Body() dto: VerifyOtpDto) {
    return await this.auth.verifyRegisterOtp(dto.email, dto.otp);
  }

  @Post('resend-registration-otp')
  async resendOtp(@Body() dto: { email: string }) {
    return await this.auth.resendRegisterOtp(dto.email);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('google')
  googleAuth(@Query('redirect') redirect?: string) {
    const backendRedirectUri = `${process.env.BACKEND_URL}/auth/google/callback`;
    const state = this.auth.createOAuthState(redirect || process.env.FRONTEND_URL);
    const url = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(backendRedirectUri)}&response_type=code&client_id=${process.env.GOOGLE_CLIENT_ID}&scope=email%20profile&state=${encodeURIComponent(state)}&access_type=offline`;
    return { redirectUrl: url.replace(/\s+/g, '') };
  }

  @Get('google/callback')
  async googleCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    try {
      const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/auth/google/callback`,
        grant_type: 'authorization_code',
      });

      const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      });

      const result = await this.auth.handleGoogleCallback(userInfoResponse.data, state);

      return res.redirect(`${process.env.FRONTEND_URL}/auth/success?accessToken=${result?.accessToken}&${result?.redirectPath ? 'redirect=' + encodeURIComponent(result.redirectPath) : ''}`);
    } catch (e) {
      return res.redirect(`${process.env.FRONTEND_URL}/auth?tab=login&error=google_failed`);
    }
  }

  // Step 1: send OTP
  @Get('sign')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  sign(@Req() req: any) {
    return this.auth.signUser(req.user?.id);

  }
  @Post('forgot-password')
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.sendResetOtp(dto.email);
  }

  // Step 2: verify OTP
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyResetOtp(dto.email, dto.otp);
  }

  // Step 3: reset password
  @Post('reset-password')
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPasswordByOtp(dto.email, dto.newPassword);
  }

  // Google login
  // @Post('google')
  // google(@Body() dto: GoogleLoginDto) {
  //   return this.auth.googleLogin(dto.idToken, dto.name);
  // }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePasswordByOldPassword(req.user.id, dto.oldPassword, dto.newPassword);
  }

  @Post('request-email-change')
  @UseGuards(JwtAuthGuard)
  requestEmailChange(@Req() req: any, @Body() dto: RequestEmailChangeDto) {
    return this.auth.requestEmailChange(req.user.id, dto.newEmail);
  }

  @Post('resend-email-request')
  @UseGuards(JwtAuthGuard)
  async resendEmailRequest(@Req() req: any) {
    return await this.auth.resendEmailChangeOtp(req.user.id);
  }

  @Post('verify-email-change')
  @UseGuards(JwtAuthGuard)
  verifyEmailChange(@Req() req: any, @Body() dto: VerifyEmailChangeDto) {
    return this.auth.verifyEmailChange(req.user.id, dto.otp);
  }
}
