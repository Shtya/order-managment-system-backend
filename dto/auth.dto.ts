import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';


export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  /**
   * This Regex ensures the password has at least:
   * 1. One uppercase letter
   * 2. One lowercase letter
   * 3. One number
   * (Matching your frontend "score" logic)
   */
  @Matches(/((?=.*\d)(?=.*[a-z])(?=.*[A-Z]))/, {
    message: 'Password is too weak. Must include uppercase, lowercase, and numbers.',
  })
  password: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty({ message: 'Company name is required' })
  companyName: string;

  @IsString()
  @IsNotEmpty({ message: 'Business type is required' })
  businessType: string;

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
