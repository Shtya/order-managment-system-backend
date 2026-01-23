// src/common/QueryFailedErrorFilter.ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { Response } from 'express';

@Catch(QueryFailedError)
export class QueryFailedErrorFilter implements ExceptionFilter {
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
