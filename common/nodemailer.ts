import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { TranslationService } from './translation.service';
import { ClientSettingsService } from 'src/client-settings/client-settings.service';



@Injectable()
export class MailService {
  private transporter = nodemailer.createTransport({
    host: process.env.Email_HOST, // اسم الخادم الصادر
    port: process.env.Email_PORT,             // المنفذ
    secure: false,         // false for STARTTLS (TLS)
    requireTLS: true,      // force TLS
    auth: {
      user: process.env.EMAIL_USER, // بريدك الإلكتروني Zoho
      pass: process.env.EMAIL_PASS, // كلمة مرور التطبيق App Password
    },
    logging: true, // Enable logging for debugging
    debugger: true, // Enable debugger for detailed logs
  });

  constructor(
    private readonly clientSettingsService: ClientSettingsService,
    private readonly translations: TranslationService,
  ) { }

  private buildFrom(): string {
    const siteName = process.env.PROJECT_NAME ?? 'No-Reply';

    return `${siteName} <${process.env.EMAIL_USER}>`;
  }
  /**
   * Helper to generate unified email HTML with RTL support and consistent styling
   */
  private buildEmailHtml(lang: string, bodyContent: string): string {
    const isAr = lang !== 'en';
    return `
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    
    body, table, td {
      font-family: 'Inter', ui-sans-serif, -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    }
    
    /* RTL Support */
    .rtl {
      direction: rtl !important;
      text-align: right !important;
    }
    
    .ltr {
      direction: ltr !important;
      text-align: left !important;
    }
    
    /* Override for elements that should stay LTR even in RTL (like OTP) */
    .otp-code {
      direction: ltr !important;
      text-align: center !important;
      unicode-bidi: bidi-override !important;
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;">
  <div style="padding:30px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,0.08);" 
         class="${isAr ? 'rtl' : 'ltr'}">
      ${bodyContent}
    </div>
  </div>
</body>
</html>
`;
  }

  /**
   * Helper to get language from user settings (defaults to 'en')
   */
  private async getLang(userId?: string): Promise<string> {
    if (!userId) return 'en';
    const settings = await this.clientSettingsService.getCachedSettings(userId);
    return settings?.defaultLang || 'en';
  }

  async sendOtpEmail(
    userEmail: string,
    data: { otp: string; userName: string },
    userId?: string,
  ) {
    const lang = await this.getLang(userId);
    const userNameFallback = data.userName || this.translations.t('common.there', { lang });
    const currentYear = new Date().getFullYear().toString();

    const bodyContent = `
      <h2 style="margin-top:0;color:#1f2937;">
        ${this.translations.t('emails.password_reset.hello', { args: { userName: userNameFallback }, lang })}
      </h2>

      <p style="color:#4b5563;font-size:15px;line-height:1.5;">
        ${this.translations.t('emails.password_reset.message', { lang })}
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
          direction:ltr !important;
          unicode-bidi:bidi-override !important;
        ">
          ${data.otp}
        </div>
      </div>

      <p style="color:#4b5563;font-size:14px;line-height:1.5;">
        ${this.translations.t('emails.password_reset.expiry', { lang })}
      </p>

      <p style="color:#6b7280;font-size:13px;margin-top:24px;line-height:1.5;">
        ${this.translations.t('emails.password_reset.ignore', { lang })}
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="color:#9ca3af;font-size:12px;text-align:center;">
        ${this.translations.t('emails.password_reset.footer', { args: { year: currentYear }, lang })}
      </p>
    `;

    const htmlContent = this.buildEmailHtml(lang, bodyContent);

    await this.transporter.sendMail({
      from: this.buildFrom(),
      to: userEmail,
      subject: this.translations.t('emails.password_reset.subject', { lang }),
      html: htmlContent,
    });
  }

  async sendRegistrationOtpEmail(
    userEmail: string,
    data: { otp: string; userName: string },
    userId?: string,
  ) {
    const lang = await this.getLang(userId);
    const userNameFallback = data.userName || this.translations.t('common.there', { lang });
    const currentYear = new Date().getFullYear().toString();

    const bodyContent = `
      <h2 style="margin-top:0;color:#1f2937;">
        ${this.translations.t('emails.registration.hello', { args: { userName: userNameFallback }, lang })}
      </h2>

      <p style="color:#4b5563;font-size:15px;line-height:1.5;">
        ${this.translations.t('emails.registration.message', { lang })}
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
          direction:ltr !important;
          unicode-bidi:bidi-override !important;
        ">
          ${data.otp}
        </div>
      </div>

      <p style="color:#4b5563;font-size:14px;line-height:1.5;">
        ${this.translations.t('emails.registration.expiry', { lang })}
      </p>

      <p style="color:#6b7280;font-size:13px;margin-top:24px;line-height:1.5;">
        ${this.translations.t('emails.registration.ignore', { lang })}
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="color:#9ca3af;font-size:12px;text-align:center;">
        ${this.translations.t('emails.registration.footer', { args: { year: currentYear }, lang })}
      </p>
    `;

    const htmlContent = this.buildEmailHtml(lang, bodyContent);

    await this.transporter.sendMail({
      from: this.buildFrom(),
      to: userEmail,
      subject: this.translations.t('emails.registration.subject', { lang }),
      html: htmlContent,
    });
  }

  async sendEmailChangeOtpEmail(
    userEmail: string,
    data: { otp: string; userName: string },
    userId?: string,
  ) {
    const lang = await this.getLang(userId);
    const userNameFallback = data.userName || this.translations.t('common.there', { lang });
    const currentYear = new Date().getFullYear().toString();

    const bodyContent = `
      <h2 style="margin-top:0;color:#1f2937;">
        ${this.translations.t('emails.email_change.hello', { args: { userName: userNameFallback }, lang })}
      </h2>

      <p style="color:#4b5563;font-size:15px;line-height:1.5;">
        ${this.translations.t('emails.email_change.message', { lang })}
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
          direction:ltr !important;
          unicode-bidi:bidi-override !important;
        ">
          ${data.otp}
        </div>
      </div>

      <p style="color:#4b5563;font-size:14px;line-height:1.5;">
        ${this.translations.t('emails.email_change.expiry', { lang })}
      </p>

      <p style="color:#6b7280;font-size:13px;margin-top:24px;line-height:1.5;">
        ${this.translations.t('emails.email_change.ignore', { lang })}
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="color:#9ca3af;font-size:12px;text-align:center;">
        ${this.translations.t('emails.email_change.footer', { args: { year: currentYear }, lang })}
      </p>
    `;

    const htmlContent = this.buildEmailHtml(lang, bodyContent);

    await this.transporter.sendMail({
      from: this.buildFrom(),
      to: userEmail,
      subject: this.translations.t('emails.email_change.subject', { lang }),
      html: htmlContent,
    });
  }

  async sendPasswordChangeNotificationEmail(
    userEmail: string,
    data: { userName: string },
    userId?: string,
  ) {
    const lang = await this.getLang(userId);
    const userNameFallback = data.userName || this.translations.t('common.there', { lang });
    const currentYear = new Date().getFullYear().toString();

    const bodyContent = `
      <h2 style="margin-top:0;color:#1f2937;">
        ${this.translations.t('emails.password_change.hello', { args: { userName: userNameFallback }, lang })}
      </h2>

      <p style="color:#4b5563;font-size:15px;line-height:1.5;">
        ${this.translations.t('emails.password_change.message', { lang })}
      </p>

      <div style="background-color:#fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="color:#991b1b;font-size:14px; margin: 0;">
          <strong>${this.translations.t('emails.password_change.security_notice_title', { lang })}</strong> ${this.translations.t('emails.password_change.security_notice_text', { lang })}
        </p>
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="color:#9ca3af;font-size:12px;text-align:center;">
        ${this.translations.t('emails.password_change.footer', { args: { year: currentYear }, lang })}
      </p>
    `;

    const htmlContent = this.buildEmailHtml(lang, bodyContent);

    await this.transporter.sendMail({
      from: this.buildFrom(),
      to: userEmail,
      subject: this.translations.t('emails.password_change.subject', { lang }),
      html: htmlContent,
    });
  }

}


