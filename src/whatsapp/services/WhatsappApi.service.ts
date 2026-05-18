import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import {
  WhatsappAccountEntity,
  WhatsappTemplateEntity,
  TemplateConfig,
  WhatsappMessageEntity,
  MessageDirection,
  MessageStatus,
  WhatsappMessageType,
} from 'entities/whatsapp.entity';
import { getErrorMessage } from 'common/healpers';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

type MetaApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type WhatsappRequestOptions = {
  accountId: string;
  method: MetaApiMethod;
  endpoint: string;
  data?: unknown;
  params?: Record<string, unknown>;
  /**
   * Which identifier to prepend
   */
  node?: 'wabaId' | 'phoneNumberId' | 'none';
  /**
   * Optional direct node id override
   */
  nodeId?: string;
  /**
   * Use raw endpoint without auto prefix
   */
  raw?: boolean;
};

export type WhatsappRecipientType = 'individual' | 'group';

export interface WhatsappMessageContext {
  message_id: string;
}

export interface WhatsappMediaObject {
  id?: string;
  link?: string;
}

export type WhatsappMediaRef = { id: string; link?: never } | { link: string; id?: never };

export interface WhatsappMessageBase {
  messaging_product: 'whatsapp';
  recipient_type?: WhatsappRecipientType;
  to: string;
  context?: WhatsappMessageContext;
}

export interface WhatsappTextMessagePayload extends WhatsappMessageBase {
  type: 'text';
  text: {
    body: string;
    preview_url?: boolean;
  };
}

export interface WhatsappImageMessagePayload extends WhatsappMessageBase {
  type: 'image';
  image: WhatsappMediaObject & {
    caption?: string;
  };
}

export interface WhatsappAudioMessagePayload extends WhatsappMessageBase {
  type: 'audio';
  audio: WhatsappMediaObject;
}

export interface WhatsappDocumentMessagePayload extends WhatsappMessageBase {
  type: 'document';
  document: WhatsappMediaObject & {
    caption?: string;
    filename?: string;
  };
}

export interface WhatsappStickerMessagePayload extends WhatsappMessageBase {
  type: 'sticker';
  sticker: WhatsappMediaObject;
}

export interface WhatsappVideoMessagePayload extends WhatsappMessageBase {
  type: 'video';
  video: WhatsappMediaObject & {
    caption?: string;
  };
}

export interface WhatsappLocationMessagePayload extends WhatsappMessageBase {
  type: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}

export interface WhatsappContactAddress {
  city?: string;
  country?: string;
  country_code?: string;
  state?: string;
  street?: string;
  type?: 'HOME' | 'WORK';
  zip?: string;
}

export interface WhatsappContactEmail {
  email: string;
  type?: 'HOME' | 'WORK';
}

export interface WhatsappContactName {
  first_name?: string;
  formatted_name: string;
  last_name?: string;
  middle_name?: string;
  prefix?: string;
  suffix?: string;
}

export interface WhatsappContactOrganization {
  company?: string;
  department?: string;
  title?: string;
}

export interface WhatsappContactPhone {
  phone: string;
  type?: 'HOME' | 'WORK';
  wa_id?: string;
}

export interface WhatsappContactUrl {
  type?: 'HOME' | 'WORK';
  url: string;
}

export interface WhatsappContactObject {
  addresses?: WhatsappContactAddress[];
  birthday?: string;
  emails?: WhatsappContactEmail[];
  name?: WhatsappContactName;
  org?: WhatsappContactOrganization;
  phones?: WhatsappContactPhone[];
  urls?: WhatsappContactUrl[];
}

export interface WhatsappContactsMessagePayload extends WhatsappMessageBase {
  type: 'contacts';
  contacts: WhatsappContactObject[];
}

export interface WhatsappReactionMessagePayload extends WhatsappMessageBase {
  type: 'reaction';
  reaction: {
    message_id: string;
    emoji: string;
  };
}

export interface WhatsappInteractiveTextHeader {
  type: 'text';
  text: string;
  sub_text?: string;
}

export interface WhatsappInteractiveMediaHeader {
  type: 'image' | 'video' | 'document';
  image?: WhatsappMediaObject;
  video?: WhatsappMediaObject;
  document?: WhatsappMediaObject;
  text?: never;
  sub_text?: string;
}

export interface WhatsappInteractiveBody {
  text: string;
}

export interface WhatsappInteractiveFooter {
  text: string;
}

export interface WhatsappInteractiveButtonReply {
  type: 'reply';
  reply: {
    id: string;
    title: string;
  };
}

export interface WhatsappInteractiveButtonCallPermission {
  type: 'call_permission_request';
  body: {
    text: string;
  };
  action: {
    title: string;
    name?: string;
  };
}

export interface WhatsappInteractiveButtonCatalog {
  type: 'catalog_message';
  body?: {
    text: string;
  };
  action: {
    catalog_id: string;
    product_retailer_id?: string;
  };
}

export interface WhatsappInteractiveButtonList {
  type: 'list';
  body: WhatsappInteractiveBody;
  action: {
    button: string;
    sections: WhatsappInteractiveSection[];
  };
  header?: WhatsappInteractiveHeaderObject;
  footer?: WhatsappInteractiveFooter;
}

export interface WhatsappInteractiveButtonProduct {
  type: 'product';
  body?: WhatsappInteractiveBody;
  action: {
    catalog_id: string;
    product_retailer_id: string;
  };
  header?: WhatsappInteractiveHeaderObject;
  footer?: WhatsappInteractiveFooter;
}

export interface WhatsappInteractiveButtonProductList {
  type: 'product_list';
  body: WhatsappInteractiveBody;
  action: {
    catalog_id: string;
    sections: WhatsappInteractiveSection[];
  };
  header: WhatsappInteractiveHeaderObject;
  footer?: WhatsappInteractiveFooter;
}

export interface WhatsappInteractiveButtonFlow {
  type: 'flow';
  body?: WhatsappInteractiveBody;
  action: Record<string, unknown>;
  header?: WhatsappInteractiveHeaderObject;
  footer?: WhatsappInteractiveFooter;
}

export type WhatsappInteractiveAction =
  | {
    type: 'button';
    buttons: WhatsappInteractiveButtonReply[];
  }
  | WhatsappInteractiveButtonList
  | WhatsappInteractiveButtonProduct
  | WhatsappInteractiveButtonProductList
  | WhatsappInteractiveButtonCallPermission
  | WhatsappInteractiveButtonCatalog
  | WhatsappInteractiveButtonFlow;

export interface WhatsappInteractiveHeaderObject {
  type: 'text' | 'video' | 'image' | 'document';
  text?: string;
  sub_text?: string;
  image?: WhatsappMediaObject;
  video?: WhatsappMediaObject;
  document?: WhatsappMediaObject;
}

export interface WhatsappInteractiveSectionRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsappInteractiveSection {
  title?: string;
  product_items?: Array<{
    product_retailer_id: string;
  }>;
  rows?: WhatsappInteractiveSectionRow[];
}

export interface WhatsappInteractiveMessagePayload extends WhatsappMessageBase {
  type: 'interactive';
  interactive:
  | {
    type: 'button';
    header?: WhatsappInteractiveHeaderObject;
    body: WhatsappInteractiveBody;
    footer?: WhatsappInteractiveFooter;
    action: {
      buttons: WhatsappInteractiveButtonReply[];
    };
  }
  | WhatsappInteractiveButtonList
  | WhatsappInteractiveButtonProduct
  | WhatsappInteractiveButtonProductList
  | WhatsappInteractiveButtonCallPermission
  | WhatsappInteractiveButtonCatalog
  | WhatsappInteractiveButtonFlow;
}

export interface WhatsappTemplateLanguage {
  code: string;
}

export interface WhatsappTemplateParameterText {
  type: 'text';
  text: string;
}

export interface WhatsappTemplateParameterCurrency {
  type: 'currency';
  currency: {
    code: string;
    amount_1000: number;
    fallback_value?: string;
  };
}

export interface WhatsappTemplateParameterDateTime {
  type: 'date_time';
  date_time: {
    fallback_value: string;
  } & Record<string, unknown>;
}

export interface WhatsappTemplateParameterMedia {
  type: 'image' | 'video' | 'document';
  image?: WhatsappMediaObject;
  video?: WhatsappMediaObject;
  document?: WhatsappMediaObject;
}

export type WhatsappTemplateParameter =
  | WhatsappTemplateParameterText
  | WhatsappTemplateParameterCurrency
  | WhatsappTemplateParameterDateTime
  | WhatsappTemplateParameterMedia;

export interface WhatsappTemplateComponentHeader {
  type: 'header';
  parameters?: WhatsappTemplateParameter[];
}

export interface WhatsappTemplateComponentBody {
  type: 'body';
  parameters?: WhatsappTemplateParameter[];
}

export interface WhatsappTemplateComponentButton {
  type: 'button';
  sub_type?: 'url' | 'quick_reply';
  index: string;
  parameters?: WhatsappTemplateParameter[];
}

export interface WhatsappTemplateComponentFooter {
  type: 'footer';
  parameters?: WhatsappTemplateParameter[];
}

export type WhatsappTemplateComponent =
  | WhatsappTemplateComponentHeader
  | WhatsappTemplateComponentBody
  | WhatsappTemplateComponentButton
  | WhatsappTemplateComponentFooter;

export interface WhatsappTemplateMessagePayload extends WhatsappMessageBase {
  type: 'template';
  template: {
    name: string;
    language: WhatsappTemplateLanguage;
    components?: WhatsappTemplateComponent[];
  };
}

export type WhatsappSendMessagePayload =
  | WhatsappTextMessagePayload
  | WhatsappImageMessagePayload
  | WhatsappAudioMessagePayload
  | WhatsappDocumentMessagePayload
  | WhatsappStickerMessagePayload
  | WhatsappVideoMessagePayload
  | WhatsappContactsMessagePayload
  | WhatsappLocationMessagePayload
  | WhatsappReactionMessagePayload
  | WhatsappInteractiveMessagePayload
  | WhatsappTemplateMessagePayload;

export interface WhatsappMessageResponseContact {
  input?: string;
  wa_id?: string;
}

export interface WhatsappMessageResponseItem {
  id?: string;
  message_status?: 'accepted' | 'held_for_quality_assessment' | 'paused';
}

export interface WhatsappMessageResponsePayload {
  contacts?: WhatsappMessageResponseContact[];
  messages?: WhatsappMessageResponseItem[];
  messaging_product?: string;
}

export interface WhatsappMarkMessageRequestPayload {
  message_id: string;
  messaging_product: 'whatsapp';
  status: 'read';
}

export interface WhatsappMarkMessageResponsePayload {
  success?: boolean;
}

export interface WhatsappSendTextMessageInput {
  to: string;
  body: string;
  previewUrl?: boolean;
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendMediaMessageInput {
  to: string;
  media: WhatsappMediaRef;
  caption?: string;
  filename?: string;
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendLocationMessageInput {
  to: string;
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendReactionMessageInput {
  to: string;
  messageId: string;
  emoji: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendContactsMessageInput {
  to: string;
  contacts: WhatsappContactObject[];
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendInteractiveMessageInput {
  to: string;
  interactive: WhatsappInteractiveMessagePayload['interactive'];
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendTemplateMessageInput {
  to: string;
  name: string;
  languageCode: string;
  components?: WhatsappTemplateComponent[];
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappSendTemplateFromEntityInput {
  to: string;
  template: WhatsappTemplateEntity;
  languageCode?: string;
  components?: WhatsappTemplateComponent[];
  replyToMessageId?: string;
  recipient_type?: WhatsappRecipientType;
}

export interface WhatsappTemplateSendableComponent {
  type?: string;
  text?: string;
  format?: string;
  example?: unknown;
  buttons?: unknown[];
}

@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);
  private readonly version = process.env.META_API_VERSION || 'v25.0';
  private readonly baseUrl = `https://graph.facebook.com/${this.version}`;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
  ) { }

  /**
   * جلب بيانات الحساب والتحقق من صحتها
   */
  private async getAccount(accountId: string): Promise<WhatsappAccountEntity> {
    const account = await this.accountRepo.findOne({
      where: { id: accountId, isActive: true },
    });

    if (!account || !account.accessToken || !account.wabaId) {
      throw new BadRequestException('WhatsApp account is inactive or missing credentials');
    }

    return account;
  }

  /**
   * دالة معالجة الأخطاء الموحدة
   */
  private handleError(error: unknown, method: string): never {
    const message = getErrorMessage(error);
    this.logger.error(`[WhatsApp API ${method}] Error:`, message);
    throw new BadRequestException(message);
  }

  private normalizeMediaObject(media: WhatsappMediaRef): WhatsappMediaObject {
    if ('id' in media) {
      return { id: media.id };
    }
    return { link: media.link };
  }

  private normalizeLanguageCode(languageCode: string): string {
    if (!languageCode) {
      return 'en_US';
    }

    if (languageCode.includes('_')) {
      return languageCode;
    }

    if (languageCode === 'en') {
      return 'en_US';
    }

    return languageCode;
  }

  private buildReplyContext(replyToMessageId?: string): WhatsappMessageContext | undefined {
    return replyToMessageId ? { message_id: replyToMessageId } : undefined;
  }

  private buildTemplateLanguageCode(template: WhatsappTemplateEntity, languageCode?: string): string {
    if (languageCode) {
      return this.normalizeLanguageCode(languageCode);
    }

    const raw = template.language || 'en';
    if (raw === 'en') {
      return 'en_US';
    }

    return raw;
  }

  private normalizeTemplateComponents(components?: WhatsappTemplateComponent[]): WhatsappTemplateComponent[] | undefined {
    if (!components || components.length === 0) {
      return undefined;
    }

    return components;
  }

  async request<T = unknown>(options: WhatsappRequestOptions): Promise<T> {
    const {
      accountId,
      method,
      endpoint,
      data,
      params,
      node = 'wabaId',
      nodeId,
      raw = false,
    } = options;

    const account = await this.getAccount(accountId);

    let url = this.baseUrl;

    if (raw) {
      url += `/${endpoint.replace(/^\/+/, '')}`;
    } else {
      let resolvedNodeId = nodeId;

      if (!resolvedNodeId) {
        if (node === 'wabaId') {
          resolvedNodeId = account.wabaId;
        }

        if (node === 'phoneNumberId') {
          resolvedNodeId = account.phoneNumberId;
        }
      }

      if (node === 'none') {
        url += `/${endpoint.replace(/^\/+/, '')}`;
      } else {
        url += `/${resolvedNodeId}/${endpoint.replace(/^\/+/, '')}`;
      }
    }

    const config = {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
      },
      params,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.request<T>({
          method,
          url,
          data,
          ...config,
        }),
      );

      return response.data;
    } catch (e) {
      this.handleError(e, method);
    }
  }

  async uploadMediaToMeta(fileUrl: string): Promise<string> {
    const appId = process.env.META_APP_ID;
    const accessToken = process.env.META_SYSTEM_TOKEN;
    const version = process.env.META_API_VERSION || 'v25.0';

    if (!appId || !accessToken) {
      throw new BadRequestException('META_APP_ID and META_SYSTEM_TOKEN are required');
    }

    // 1. Convert local URL → absolute file path
    const filePath = path.join(process.cwd(), fileUrl);

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException('File not found: ' + filePath);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileStats = fs.statSync(filePath);

    const fileName = path.basename(filePath);
    const fileLength = fileStats.size;

    // 2. Detect MIME type (simple version)
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
    };

    const fileType = mimeTypeMap[ext];

    if (!fileType) {
      throw new BadRequestException('Unsupported file type');
    }

    try {
      // 3. Start upload session
      const sessionRes = await axios.post<{ id: string }>(
        `https://graph.facebook.com/${version}/${appId}/uploads`,
        null,
        {
          params: {
            file_name: fileName,
            file_length: fileLength,
            file_type: fileType,
            access_token: accessToken,
          },
        },
      );

      const sessionId = sessionRes.data.id; // upload:xxxx

      // 4. Upload file
      const uploadRes = await axios.post<{ h: string }>(
        `https://graph.facebook.com/${version}/${sessionId}`,
        fileBuffer,
        {
          headers: {
            Authorization: `OAuth ${accessToken}`,
            file_offset: '0',
            'Content-Type': 'application/octet-stream',
          },
          maxBodyLength: Infinity,
        },
      );

      // 5. Return file handle
      return uploadRes.data.h;
    } catch (e) {
      this.handleError(e, 'uploadMediaToMeta');
    }
  }

  async sendMessage(
    accountId: string,
    payload: WhatsappSendMessagePayload,
  ): Promise<WhatsappMessageResponsePayload> {
    const response = await this.request<WhatsappMessageResponsePayload>({
      accountId,
      method: 'POST',
      endpoint: 'messages',
      node: 'phoneNumberId',
      data: payload,
    });

    // Save message to database
    try {
      const account = await this.getAccount(accountId);
      const messageId = response.messages?.[0]?.id;

      if (messageId) {
        const message = this.messageRepo.create({
          adminId: account.adminId,
          accountId: account.id,
          messageId,
          contactNumber: payload.to,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.ACCEPTED,
          messageType: payload.type as any, // Mapping string to enum
          content: payload,
        });

        await this.messageRepo.save(message);
      }
    } catch (e) {
      this.logger.error('Failed to save sent message to database', e);
    }

    return response;
  }

  async markMessageAsRead(
    accountId: string,
    messageId: string,
  ): Promise<WhatsappMarkMessageResponsePayload> {
    const payload: WhatsappMarkMessageRequestPayload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };

    return this.request<WhatsappMarkMessageResponsePayload>({
      accountId,
      method: 'POST',
      endpoint: 'messages',
      node: 'phoneNumberId',
      data: payload,
    });
  }

  async sendTextMessage(
    accountId: string,
    input: WhatsappSendTextMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappTextMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'text',
      text: {
        body: input.body,
        preview_url: input.previewUrl,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendImageMessage(
    accountId: string,
    input: WhatsappSendMediaMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappImageMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'image',
      image: {
        ...this.normalizeMediaObject(input.media),
        caption: input.caption,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendAudioMessage(
    accountId: string,
    input: WhatsappSendMediaMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappAudioMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'audio',
      audio: this.normalizeMediaObject(input.media),
    };

    return this.sendMessage(accountId, payload);
  }

  async sendDocumentMessage(
    accountId: string,
    input: WhatsappSendMediaMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappDocumentMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'document',
      document: {
        ...this.normalizeMediaObject(input.media),
        caption: input.caption,
        filename: input.filename,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendVideoMessage(
    accountId: string,
    input: WhatsappSendMediaMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappVideoMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'video',
      video: {
        ...this.normalizeMediaObject(input.media),
        caption: input.caption,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendStickerMessage(
    accountId: string,
    input: WhatsappSendMediaMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappStickerMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'sticker',
      sticker: this.normalizeMediaObject(input.media),
    };

    return this.sendMessage(accountId, payload);
  }

  async sendLocationMessage(
    accountId: string,
    input: WhatsappSendLocationMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappLocationMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'location',
      location: {
        latitude: input.latitude,
        longitude: input.longitude,
        name: input.name,
        address: input.address,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendContactsMessage(
    accountId: string,
    input: WhatsappSendContactsMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappContactsMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'contacts',
      contacts: input.contacts,
    };

    return this.sendMessage(accountId, payload);
  }

  async sendReactionMessage(
    accountId: string,
    input: WhatsappSendReactionMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappReactionMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      type: 'reaction',
      reaction: {
        message_id: input.messageId,
        emoji: input.emoji,
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendInteractiveMessage(
    accountId: string,
    input: WhatsappSendInteractiveMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappInteractiveMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'interactive',
      interactive: input.interactive,
    };

    return this.sendMessage(accountId, payload);
  }

  async sendListMessage(
    accountId: string,
    input: {
      to: string;
      body: string;
      button: string;
      sections: WhatsappInteractiveSection[];
      header?: WhatsappInteractiveHeaderObject;
      footer?: WhatsappInteractiveFooter;
      replyToMessageId?: string;
      recipient_type?: WhatsappRecipientType;
    },
  ): Promise<WhatsappMessageResponsePayload> {
    return this.sendInteractiveMessage(accountId, {
      to: input.to,
      recipient_type: input.recipient_type,
      replyToMessageId: input.replyToMessageId,
      interactive: {
        type: 'list',
        body: { text: input.body },
        action: {
          button: input.button,
          sections: input.sections,
        },
        header: input.header,
        footer: input.footer,
      },
    });
  }

  async sendButtonMessage(
    accountId: string,
    input: {
      to: string;
      body: string;
      buttons: WhatsappInteractiveButtonReply[];
      header?: WhatsappInteractiveHeaderObject;
      footer?: WhatsappInteractiveFooter;
      replyToMessageId?: string;
      recipient_type?: WhatsappRecipientType;
    },
  ): Promise<WhatsappMessageResponsePayload> {
    return this.sendInteractiveMessage(accountId, {
      to: input.to,
      recipient_type: input.recipient_type,
      replyToMessageId: input.replyToMessageId,
      interactive: {
        type: 'button',
        body: { text: input.body },
        header: input.header,
        footer: input.footer,
        action: {
          buttons: input.buttons,
        },
      },
    });
  }

  async sendProductMessage(
    accountId: string,
    input: {
      to: string;
      catalogId: string;
      productRetailerId: string;
      body?: string;
      header?: WhatsappInteractiveHeaderObject;
      footer?: WhatsappInteractiveFooter;
      replyToMessageId?: string;
      recipient_type?: WhatsappRecipientType;
    },
  ): Promise<WhatsappMessageResponsePayload> {
    return this.sendInteractiveMessage(accountId, {
      to: input.to,
      recipient_type: input.recipient_type,
      replyToMessageId: input.replyToMessageId,
      interactive: {
        type: 'product',
        body: input.body ? { text: input.body } : undefined,
        header: input.header,
        footer: input.footer,
        action: {
          catalog_id: input.catalogId,
          product_retailer_id: input.productRetailerId,
        },
      },
    });
  }

  async sendProductListMessage(
    accountId: string,
    input: {
      to: string;
      catalogId: string;
      body: string;
      sections: WhatsappInteractiveSection[];
      header: WhatsappInteractiveHeaderObject;
      footer?: WhatsappInteractiveFooter;
      replyToMessageId?: string;
      recipient_type?: WhatsappRecipientType;
    },
  ): Promise<WhatsappMessageResponsePayload> {
    return this.sendInteractiveMessage(accountId, {
      to: input.to,
      recipient_type: input.recipient_type,
      replyToMessageId: input.replyToMessageId,
      interactive: {
        type: 'product_list',
        body: { text: input.body },
        header: input.header,
        footer: input.footer,
        action: {
          catalog_id: input.catalogId,
          sections: input.sections,
        },
      },
    });
  }

  async sendTemplateMessage(
    accountId: string,
    input: WhatsappSendTemplateMessageInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payload: WhatsappTemplateMessagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: input.recipient_type ?? 'individual',
      to: input.to,
      context: this.buildReplyContext(input.replyToMessageId),
      type: 'template',
      template: {
        name: input.name,
        language: {
          code: this.normalizeLanguageCode(input.languageCode),
        },
        components: this.normalizeTemplateComponents(input.components),
      },
    };

    return this.sendMessage(accountId, payload);
  }

  async sendTemplateFromEntity(
    accountId: string,
    input: WhatsappSendTemplateFromEntityInput,
  ): Promise<WhatsappMessageResponsePayload> {
    const payloadComponents = input.components ?? this.buildTemplateComponentsFromConfig(input.template.templateConfig);

    return this.sendTemplateMessage(accountId, {
      to: input.to,
      name: input.template.name,
      languageCode: this.buildTemplateLanguageCode(input.template, input.languageCode),
      components: payloadComponents,
      replyToMessageId: input.replyToMessageId,
      recipient_type: input.recipient_type,
    });

  }

  /**
   * يحاول تحويل templateConfig المخزّن إلى components جاهزة للإرسال.
   * هذا التحويل "best effort" لأن شكل templateConfig عندك يصف القالب أكثر من كونه payload مباشر.
   */
  private buildTemplateComponentsFromConfig(
    config?: TemplateConfig,
  ): WhatsappTemplateComponent[] | undefined {
    if (!config) {
      return undefined;
    }

    const components: WhatsappTemplateComponent[] = [];

    if (config.headerType) {
      if (config.headerType === 'TEXT' && config.headerText) {
        components.push({
          type: 'header',
          parameters: [{ type: 'text', text: config.headerText }],
        });
      }

      if (
        (config.headerType === 'IMAGE' ||
          config.headerType === 'VIDEO' ||
          config.headerType === 'DOCUMENT') &&
        config.headerUrl
      ) {
        const mediaType = config.headerType.toLowerCase() as 'image' | 'video' | 'document';
        components.push({
          type: 'header',
          parameters: [
            {
              type: mediaType,
              [mediaType]: { link: config.headerUrl },
            } as WhatsappTemplateParameterMedia,
          ],
        });
      }
    }

    if (config.bodyText) {
      components.push({
        type: 'body',
        parameters: Object.values(config.examples ?? {}).map((value) => ({
          type: 'text',
          text: value,
        })),
      });
    }

    if (config.buttons?.length) {
      config.buttons.forEach((button, index) => {
        if (button.type === 'VISIT_WEBSITE' && button.url) {
          components.push({
            type: 'button',
            sub_type: 'url',
            index: String(index),
            parameters: [
              {
                type: 'text',
                text: button.urlExample ?? button.url,
              },
            ],
          });
        }
      });
    }

    return components.length ? components : undefined;
  }

  /**
   * Convenience helper when you already have the stored template row and want to send it.
   * It uses templateConfig only as a fallback for simple static templates.
   */
  async sendStoredTemplateMessage(
    accountId: string,
    input: {
      to: string;
      templateId: string;
      replyToMessageId?: string;
      recipient_type?: WhatsappRecipientType;
    },
  ): Promise<WhatsappMessageResponsePayload> {
    const templateRepo = this.accountRepo.manager.getRepository(WhatsappTemplateEntity);
    const template = await templateRepo.findOne({
      where: { id: input.templateId, isActive: true },
    });

    if (!template) {
      throw new BadRequestException('Template not found or inactive');
    }

    return this.sendTemplateFromEntity(accountId, {
      to: input.to,
      template,
      replyToMessageId: input.replyToMessageId,
      recipient_type: input.recipient_type,
    });
  }
}

//2083073232550708|FZA1J48hbXlZvAxAb03saMhXJUM

export type WhatsappTemplateComponentDto =
  | HeaderTextComponentDto
  | HeaderMediaComponentDto
  | HeaderLocationComponentDto
  | BodyComponentDto
  | FooterComponentDto
  | ButtonsComponentDto
  | TypeComponentDto;

export class TypeComponentDto {
  type: string;
}

export class ButtonsComponentDto {
  type: 'BUTTONS';

  buttons: Array<
    | {
      type: 'PHONE_NUMBER';
      text: string;
      phone_number: string;
    }
    | {
      type: 'URL';
      text: string;
      url: string;
      example?: string[];
    }
    | {
      type: 'QUICK_REPLY';
      text: string;
    }
    | {
      type: 'VOICE_CALL';
      text: string;
      ttl_minutes: number;
    }
    | {
      type: 'otp';
      otp_type: string;
      text?: string;
    }
  >;
}

export class HeaderTextComponentDto {
  type: 'HEADER';

  format: 'TEXT';

  text: string;

  example?: {
    header_text?: string[];

    header_text_named_params?: Array<{
      param_name: string;
      example: string;
    }>;
  };
}

export class HeaderMediaComponentDto {
  type: 'HEADER';

  format: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'GIF';

  example: {
    header_handle: string[];
  };
}

export class HeaderLocationComponentDto {
  type: 'HEADER';

  format: 'LOCATION';
}

export class BodyComponentDto {
  type: 'BODY';
  add_security_recommendation?: boolean;
  text?: string;

  example?: {
    body_text?: string[][];

    body_text_named_params?: Array<{
      param_name: string;
      example: string;
    }>;
  };
}

export class FooterComponentDto {
  type: 'FOOTER';
  code_expiration_minutes?: number;
  text: string;
}

export class WhatsappTemplateRemoteDto {
  name: string;

  language: string; // "en_US"

  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

  sub_category?: string;

  /** WhatsApp template message send TTL (seconds), when custom validity is enabled */
  message_send_ttl_seconds?: number;

  parameter_format?: 'POSITIONAL' | 'NAMED';

  allow_category_change?: boolean;

  cta_url_link_tracking_opted_out?: boolean;

  send_type?: 'DIRECT' | 'COMPANION';

  display_format?: string;

  components: WhatsappTemplateComponentDto[];
}
