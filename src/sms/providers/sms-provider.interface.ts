import { SmsProviderType } from "entities/sms.entity";

export type SendSmsResult = {
  success: boolean;
  providerMessageId?: string;
  providerResponse?: any;
  error?: string;
};

export type VerifyCredentialsResult = {
  valid: boolean;
  message: string;
};

export type SmsCredentials = {
  username: string;
  password: string;
};

export type SendSmsPayload = {
  toNumber: string;
  message: string;
  sender: string;
};

export abstract class SmsProvider {
  abstract readonly code: SmsProviderType;
  abstract readonly displayName: string;

  abstract sendSms(
    credentials: SmsCredentials,
    payload: SendSmsPayload,
  ): Promise<SendSmsResult>;
  // abstract verifyCredentials(credentials: SmsCredentials): Promise<VerifyCredentialsResult>;
}
