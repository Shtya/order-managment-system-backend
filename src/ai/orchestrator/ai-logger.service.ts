import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class AiLoggerService {
  private readonly logger = new Logger("AI");

  info(message: string, meta?: Record<string, unknown>) {
    this.logger.log(this.format(message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.logger.warn(this.format(message, meta));
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>) {
    this.logger.error(
      this.format(message, meta),
      error instanceof Error ? error.stack : undefined,
    );
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.logger.debug(this.format(message, meta));
  }

  private format(message: string, meta?: Record<string, unknown>): string {
    if (!meta || Object.keys(meta).length === 0) return message;
    return `${message} ${JSON.stringify(meta)}`;
  }
}
