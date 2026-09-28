import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { RequestContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

interface ErrorBody {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export function toErrorBody(exception: unknown): ErrorBody {
  if (exception instanceof AppError) {
    return { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
  }
  if (exception instanceof ThrottlerException) {
    return { status: 429, code: ErrorCode.RATE_LIMITED, message: 'Too many requests. Please slow down.' };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    const message =
      typeof res === 'string' ? res : Array.isArray((res as any).message) ? (res as any).message.join(', ') : (res as any).message;
    const code =
      status === 401
        ? ErrorCode.UNAUTHENTICATED
        : status === 403
          ? ErrorCode.FORBIDDEN
          : status === 404
            ? ErrorCode.NOT_FOUND
            : status === 409
              ? ErrorCode.CONFLICT
              : status === 400
                ? ErrorCode.VALIDATION_FAILED
                : ErrorCode.INTERNAL_ERROR;
    return { status, code, message: message ?? exception.message };
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') {
      const target = (exception.meta?.target as string[] | undefined)?.filter((t) => t !== 'tenantId').join(', ');
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.DUPLICATE,
        message: `A record with the same ${target || 'value'} already exists.`,
      };
    }
    if (exception.code === 'P2025') {
      return { status: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, message: 'Record not found.' };
    }
    if (exception.code === 'P2003') {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'This record is referenced by other records and cannot be changed.',
      };
    }
  }
  return { status: 500, code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong. Please try again.' };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse();
    const body = toErrorBody(exception);
    if (body.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      Sentry.captureException(exception);
    }
    res.status(body.status).json({
      success: false,
      error: { code: body.code, message: body.message, ...(body.details ? { details: body.details } : {}) },
      requestId: RequestContext.requestId,
    });
  }
}
