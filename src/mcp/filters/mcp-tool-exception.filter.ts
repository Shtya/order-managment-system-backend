import {
  ArgumentsHost,
  Catch,
  HttpException,
  Injectable,
} from "@nestjs/common";
import { RpcException } from "@nestjs/microservices";
import { Observable, throwError } from "rxjs";
import { QueryFailedError } from "typeorm";

/**
 * Nest's default RPC handler turns every non-RpcException into
 * "Internal server error" before mcp-nest can send it to the client.
 * This filter maps HTTP / DB / Error into `{ status, message }` so
 * tools/call returns isError with a readable text.
 */
@Catch()
@Injectable()
export class McpToolExceptionFilter {
  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    if (exception instanceof RpcException) {
      return throwError(() => exception.getError());
    }
    return throwError(() => ({
      status: "error",
      message: this.toMessage(exception),
    }));
  }

  private toMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === "string") return body;
      if (body && typeof body === "object") {
        const msg = (body as { message?: unknown }).message;
        if (typeof msg === "string") return msg;
        if (Array.isArray(msg)) return msg.map(String).join("; ");
      }
      return exception.message;
    }

    if (exception instanceof QueryFailedError) {
      const driver = (
        exception as QueryFailedError & {
          driverError?: { code?: string; column?: string; detail?: string };
        }
      ).driverError;
      const code = driver?.code;
      const column = driver?.column;
      if (code === "23502") {
        return column
          ? `Missing required field "${column}".`
          : "A required database field was empty.";
      }
      if (code === "23503") {
        return "Related record not found (invalid id).";
      }
      if (code === "23505") {
        return "A record with the same unique value already exists.";
      }
      return exception.message.split("\n")[0];
    }

    if (exception instanceof Error) return exception.message;
    return "Internal server error";
  }
}
