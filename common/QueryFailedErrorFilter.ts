// src/common/QueryFailedErrorFilter.ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import * as fs from 'fs';
import { SystemErorrsService } from 'src/system-erorrs/system-erorrs.service';

@Injectable()
@Catch(QueryFailedError)
export class QueryFailedErrorFilter implements ExceptionFilter {
  constructor(private readonly systemErorrsService: SystemErorrsService) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<any>();

    const files = req.files as any;
    if (files) {
      const allFiles = [...(files.images || []), ...(files.documentImage || [])];
      allFiles.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }

    const code = exception?.driverError?.code as string | undefined;
    const detail = exception?.driverError?.detail ?? exception?.message;

    // Log the error to database
    this.logSystemError(exception, req, code, detail);

    // Map of common Postgres error codes → friendly messages
    const pgMap: Record<string, { status: number; message: string; error: string }> = {
      // Foreign key violation
      '23503': {
        status: HttpStatus.BAD_REQUEST,
        message: 'Cannot delete or update because related records exist.',
        error: 'Foreign Key Constraint Violation',
      },
      // Unique constraint violation
      '23505': {
        status: HttpStatus.CONFLICT,
        message: 'Duplicate value violates unique constraint.',
        error: 'Unique Constraint Violation',
      },
      // Not-null constraint violation
      '23502': {
        status: HttpStatus.BAD_REQUEST,
        message: 'A required field is missing a value.',
        error: 'Not Null Violation',
      },
      // Check constraint violation
      '23514': {
        status: HttpStatus.BAD_REQUEST,
        message: 'Value fails a check constraint.',
        error: 'Check Constraint Violation',
      },
      // Invalid text representation (e.g., UUID parse error)
      '22P02': {
        status: HttpStatus.BAD_REQUEST,
        message: 'Invalid input format.',
        error: 'Invalid Text Representation',
      },
      // Undefined table
      '42P01': {
        status: HttpStatus.BAD_REQUEST,
        message: 'Referenced table does not exist or is not available.',
        error: 'Missing FROM Clause Entry',
      },
      // Undefined column
      '42703': {
        status: HttpStatus.BAD_REQUEST,
        message: 'Referenced column does not exist.',
        error: 'Undefined Column',
      },
    };

    if (code && pgMap[code]) {
      const { status, message, error } = pgMap[code];
      return response.status(status).json({
        statusCode: status,
        message,
        error,
        code,
        details: detail,
      });
    }

    // Fallback for any other DB error
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Unexpected database error.',
      error: 'Database Error',
      code,
      details: detail,
    });
  }

  private logSystemError(exception: any, req: any, code: string | undefined, detail: string) {
    try {
      const errorData = {
        userId: req.user?.id || null,
        adminId: req.user?.adminId || null,
        endpoint: req.url || null,
        method: req.method || null,
        requestPayload: req.body || null,
        headers: req.headers || null,
        pathParams: req.params || null,
        searchParams: req.query || null,
        errorMessage: detail || exception.message,
        stackTrace: exception.stack || null,
        ipAddress: req.ip || req.connection?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
        contentType: req.headers['content-type'] || null,
        environment: process.env.NODE_ENV || null,
        httpStatus: null, // Will be set after response
        serviceName: 'order-management-backend',
        exceptionName: exception.name || 'QueryFailedError',
        errorCode: code || null,
        severity: 'error' as const,
        referer: req.headers['referer'] || null,
      };

      this.systemErorrsService.logError(errorData);
    } catch (e) {
      // Silently fail to avoid infinite loops
      console.error('Failed to log system error:', e);
    }
  }
}