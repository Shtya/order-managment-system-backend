import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
 

export class RegisterDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString() @MinLength(6)
  password: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString() @IsNotEmpty()
  password: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString() @IsNotEmpty()
  otp: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString() @MinLength(6)
  newPassword: string;
}

// Google
export class GoogleLoginDto {
  @IsString() @IsNotEmpty()
  idToken: string;

  @IsOptional() @IsString()
  name?: string;
}
