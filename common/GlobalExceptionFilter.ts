// src/common/GlobalExceptionFilter .ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Injectable, NestInterceptor, CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { ExecutionContext as NestExecutionContext } from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import * as fs from 'fs';
import { SystemErorrsService } from 'src/system-erorrs/system-erorrs.service';
import { tenantId } from 'src/purchases/purchases.service';
import { Observable } from 'rxjs';


@Catch(QueryFailedError)
export class QueryExceptionFilter implements ExceptionFilter {
  constructor(private readonly systemErorrsService: SystemErorrsService) { }

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const code = exception?.driverError?.code as string | undefined;
    const detail = exception?.driverError?.detail ?? exception?.message;


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

}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly systemErorrsService: SystemErorrsService) { }

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
    this.logSystemError(exception, req, response, code, detail);

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const errorResponse = exception instanceof HttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };

    // If NestJS generated an object (standard behavior), return as JSON. 
    // If it generated a raw string, return it as a standard send().
    if (typeof errorResponse === 'object') {
      return response.status(status).json(errorResponse);
    } else {
      return response.status(status).send(errorResponse);
    }

  }

  private logSystemError(exception: any, req: any, res: any, code: string | undefined, detail: string) {
    // Skip logging certain error patterns
    const skipPatterns = [
      'Cannot GET ',
      'Missing adminId',
    ];

    const errorMessage = detail || exception.message;
    if (skipPatterns.some(pattern => errorMessage?.startsWith?.(pattern))) {
      return;
    }

    const durationMs = req.startTime
      ? Date.now() - req.startTime
      : null;


    const httpStatus =
      exception?.status ||
      exception?.statusCode ||
      500;


    let severity: 'fatal' | 'error' | 'warn';

    if (httpStatus >= 500) {
      severity = 'fatal';
    } else if (httpStatus >= 400) {
      severity = 'warn';
    } else {
      severity = 'error';
    }

    if (
      exception?.name === 'QueryFailedError' &&
      !exception?.driverError?.code
    ) {
      severity = 'fatal';
    }
    const responseData = exception?.response

    const dbContext =
      exception?.query || exception?.parameters || exception?.driverError
        ? {
          query: exception?.query || null,
          parameters: exception?.parameters || null,
          driverError: exception?.driverError || null,
          raw: exception?.driverError?.routine || null,
          postgres: {
            code: exception?.driverError?.code || null,
            detail: exception?.driverError?.detail || null,
            hint: exception?.driverError?.hint || null,
            table: exception?.driverError?.table || null,
            column: exception?.driverError?.column || null,
            constraint: exception?.driverError?.constraint || null,
            schema: exception?.driverError?.schema || null,
            dataType: exception?.driverError?.dataType || null,
          },
        }
        : null;

    const originalUrl = req.originalUrl || null;
    const routePath = req.route?.path || null;

    try {
      const adminId = tenantId(req.user);
      routePath
      const errorData = {
        userId: req.user?.id || null,
        adminId: adminId || null,
        endpoint: req.url || null,
        originalUrl,
        routePath,
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
        frontendRoute: req.headers['x-frontend-route'] || null,
        environment: process.env.NODE_ENV || null,
        exceptionName: exception.name || 'QueryFailedError',
        errorCode: code || null,
        durationMs,
        severity,
        httpStatus,
        responseData,
        dbContext,
        controllerName: req.controllerName || null,
        handlerName: req.handlerName || null,
        requestSize: req.headers['content-length'] ? Number(req.headers['content-length']) : null,
        responseSize: res.getHeader?.('content-length') || null,
        referer: req.headers['referer'] || null,
      };

      this.systemErorrsService.logError(errorData);
    } catch (e) {
      // Silently fail to avoid infinite loops
      console.error('Failed to log system error:', e);
    }
  }
}