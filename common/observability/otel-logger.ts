import {
    ConsoleLogger,
    Injectable,
    LoggerService,
  } from '@nestjs/common';
  import { logs, SeverityNumber } from '@opentelemetry/api-logs';
  
  @Injectable()
  export class OtelLogger extends ConsoleLogger implements LoggerService {
    private readonly otelLogger = logs.getLogger('madar-backend');
  
    private emit(
      severityNumber: SeverityNumber,
      severityText: string,
      message: unknown,
      context?: string,
    ) {
      this.otelLogger.emit({
        severityNumber,
        severityText,
        body: typeof message === 'string'
          ? message
          : JSON.stringify(message),
        attributes: {
          'logger.name': context ?? 'Nest',
        },
      });
    }
  
    override log(message: any, ...optionalParams: any[]) {
      super.log(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.INFO,
        'INFO',
        message,
        context,
      );
    }
  
    override warn(message: any, ...optionalParams: any[]) {
      super.warn(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.WARN,
        'WARN',
        message,
        context,
      );
    }
  
    override error(message: any, ...optionalParams: any[]) {
      super.error(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.ERROR,
        'ERROR',
        message,
        context,
      );
    }
  
    override debug(message: any, ...optionalParams: any[]) {
      super.debug(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.DEBUG,
        'DEBUG',
        message,
        context,
      );
    }
  
    override verbose(message: any, ...optionalParams: any[]) {
      super.verbose(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.TRACE,
        'VERBOSE',
        message,
        context,
      );
    }
  
    override fatal(message: any, ...optionalParams: any[]) {
      super.fatal(message, ...optionalParams);
  
      const context =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? optionalParams[optionalParams.length - 1]
          : undefined;
  
      this.emit(
        SeverityNumber.FATAL,
        'FATAL',
        message,
        context,
      );
    }
  }