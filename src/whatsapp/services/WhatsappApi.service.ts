import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { getErrorMessage } from 'common/healpers';
import * as fs from "fs";
import * as path from "path";
import axios from "axios";

type WhatsappRequestOptions = {
  accountId: string;

  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

  endpoint: string;

  data?: any;

  params?: any;

  /**
   * Which identifier to prepend
   */
  node?:
  | "wabaId"
  | "phoneNumberId"
  | "none";

  /**
   * Optional direct node id override
   */
  nodeId?: string;

  /**
   * Use raw endpoint without auto prefix
   */
  raw?: boolean;
};


@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);
  private readonly version = process.env.META_API_VERSION || 'v25.0';
  private readonly baseUrl = `https://graph.facebook.com/${this.version}`;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
  ) { }

  /**
   * جلب بيانات الحساب والتحقق من صحتها
   */
  private async getAccount(accountId: string): Promise<WhatsappAccountEntity> {
    const account = await this.accountRepo.findOne({ where: { id: accountId, isActive: true } });
    if (!account || !account.accessToken || !account.wabaId) {
      throw new BadRequestException("WhatsApp account is inactive or missing credentials");
    }
    return account;
  }


  /**
   * دالة معالجة الأخطاء الموحدة
   */
  private handleError(error: any, method: string) {
    const message = getErrorMessage(error);
    this.logger.error(`[WhatsApp API ${method}] Error:`, message);
    throw new BadRequestException(message);
  }
  async request(options: WhatsappRequestOptions) {
    const {
      accountId,
      method,
      endpoint,
      data,
      params,
      node = "wabaId",
      nodeId,
      raw = false,
    } = options;

    const account = await this.getAccount(accountId);

    let url = this.baseUrl;

    if (raw) {
      url += `/${endpoint.replace(/^\/+/, "")}`;
    } else {
      let resolvedNodeId = nodeId;

      if (!resolvedNodeId) {
        if (node === "wabaId") {
          resolvedNodeId = account.wabaId;
        }

        if (node === "phoneNumberId") {
          resolvedNodeId = account.phoneNumberId;
        }
      }

      if (node === "none") {
        url += `/${endpoint.replace(/^\/+/, "")}`;
      } else {
        url += `/${resolvedNodeId}/${endpoint.replace(/^\/+/, "")}`;
      }
    }

    const config = {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      params,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.request({
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
    const version = process.env.META_API_VERSION || "v25.0";

    // 1. Convert local URL → absolute file path
    const filePath = path.join(process.cwd(), fileUrl);

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException("File not found: " + filePath);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileStats = fs.statSync(filePath);

    const fileName = path.basename(filePath);
    const fileLength = fileStats.size;

    // 2. Detect MIME type (simple version)
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypeMap: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".pdf": "application/pdf",
      ".mp4": "video/mp4",
    };

    const fileType = mimeTypeMap[ext];

    if (!fileType) {
      throw new BadRequestException("Unsupported file type");
    }

    // 3. Start upload session
    const sessionRes = await axios.post(
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
    const uploadRes = await axios.post(
      `https://graph.facebook.com/${version}/${sessionId}`,
      fileBuffer,
      {
        headers: {
          Authorization: `OAuth ${accessToken}`,
          "file_offset": "0",
          "Content-Type": "application/octet-stream",
        },
        maxBodyLength: Infinity,
      },
    );

    // 5. Return file handle
    return uploadRes.data.h;
  }

}

//2083073232550708|FZA1J48hbXlZvAxAb03saMhXJUM

export type WhatsappTemplateComponentDto =
  | HeaderTextComponentDto
  | HeaderMediaComponentDto
  | HeaderLocationComponentDto
  | BodyComponentDto
  | FooterComponentDto
  | ButtonsComponentDto;

export class ButtonsComponentDto {
  type: "BUTTONS";

  buttons: Array<
    | {
      type: "PHONE_NUMBER";
      text: string;
      phone_number: string;
    }
    | {
      type: "URL";
      text: string;
      url: string;
      example?: string[];
    }
    | {
      type: "QUICK_REPLY";
      text: string;
    } |
    {
      type: "VOICE_CALL";
      text: string;
      ttl_minutes: number;
    }
  >;
}

export class HeaderTextComponentDto {
  type: "HEADER";

  format: "text";

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
  type: "HEADER";

  format: "IMAGE" | "VIDEO" | "DOCUMENT" | "GIF";

  example: {
    header_handle: string[];
  };
}

export class HeaderLocationComponentDto {
  type: "HEADER";

  format: "LOCATION";
}

export class BodyComponentDto {
  type: "BODY";

  text: string;

  example?: {
    body_text?: string[];

    body_text_named_params?: Array<{
      param_name: string;
      example: string;
    }>;
  };
}

export class FooterComponentDto {
  type: "FOOTER";

  text: string;
}
export class WhatsappTemplateRemoteDto {
  name: string;

  language: string; // "en_US"

  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";

  sub_category?: string;

  parameter_format?: "POSITIONAL" | "NAMED";

  allow_category_change?: boolean;

  cta_url_link_tracking_opted_out?: boolean;

  send_type?: "DIRECT" | "COMPANION";

  display_format?: string;

  components: WhatsappTemplateComponentDto[];
}