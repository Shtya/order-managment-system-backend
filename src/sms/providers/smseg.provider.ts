import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SmsProvider } from './sms-provider.interface';
import { SmsCredentials, SendSmsPayload, SendSmsResult, VerifyCredentialsResult } from './sms-provider.interface';
import { SmsProviderType } from 'entities/sms.entity';

@Injectable()
export class SmsegProvider extends SmsProvider {
  readonly code = SmsProviderType.SMSEG;
  readonly displayName = 'SMSEG';

  private readonly baseUrl = process.env.SMSEG_API_URL || 'http://smssmartegypt.com';

  constructor(private readonly httpService: HttpService) {
    super();
  }

  async sendSms(credentials: SmsCredentials, payload: SendSmsPayload): Promise<SendSmsResult> {
    try {
      const params = new URLSearchParams({
        username: credentials.username,
        password: credentials.password,
        sendername: payload.sender,
        mobiles: payload.toNumber.startsWith('20') ? payload.toNumber : `20${payload.toNumber}`,
        message: payload.message,
      });

      const url = `${this.baseUrl}/sms/api/?${params.toString()}`;
      const response = await firstValueFrom(
        this.httpService.post(url, null, { responseType: 'json' })
      );

      const data = response.data;

      if (data?.type === 'success') {
        return {
          success: true,
          providerMessageId: data?.data?.smsid?.toString(),
          providerResponse: data,
        };
      }

      return {
        success: false,
        error: data?.msg || 'Unknown SMS API error',
        providerResponse: data,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.response?.data?.msg || err?.message || 'Unknown SMS API error',
      };
    }
  }

}
