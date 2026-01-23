import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
	public transporter = nodemailer.createTransport({
		service: 'gmail',
		auth: {
			user: process.env.EMAIL_USER,
			pass: process.env.EMAIL_PASS,
		},
	});

	async sendOtpEmail(
		userEmail: string,
		data: { otp: string; userName: string }
	) {
		const subject = 'Your Password Reset Code';

		const htmlContent = `
  <div style="background-color:#f4f6f8;padding:30px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,0.08);">

      <h2 style="margin-top:0;color:#1f2937;">
        Hello ${data.userName || 'there'},
      </h2>

      <p style="color:#4b5563;font-size:15px;">
        We received a request to reset your password.  
        Please use the verification code below to continue:
      </p>

      <div style="text-align:center;margin:30px 0;">
        <div style="
          display:inline-block;
          background:#f0f4ff;
          color:#1d4ed8;
          font-size:32px;
          font-weight:700;
          letter-spacing:6px;
          padding:16px 28px;
          border-radius:6px;
        ">
          ${data.otp}
        </div>
      </div>

      <p style="color:#4b5563;font-size:14px;">
        This code will expire in <strong>10 minutes</strong>.
      </p>

      <p style="color:#6b7280;font-size:13px;margin-top:24px;">
        If you did not request a password reset, you can safely ignore this email.
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="color:#9ca3af;font-size:12px;text-align:center;">
        © ${new Date().getFullYear()} Your Company. All rights reserved.
      </p>
    </div>
  </div>
  `;

		await this.transporter.sendMail({
			to: userEmail,
			subject,
			html: htmlContent,
		});
	}

}
