import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static notFound(entity: string) {
    return new AppError(ErrorCode.NOT_FOUND, `${entity} not found.`, HttpStatus.NOT_FOUND);
  }

  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppError(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  static conflict(message: string, code: ErrorCode = ErrorCode.CONFLICT) {
    return new AppError(code, message, HttpStatus.CONFLICT);
  }

  static invalidState(message: string) {
    return new AppError(ErrorCode.INVALID_STATE, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  static unauthenticated(message = 'Authentication required.', code: ErrorCode = ErrorCode.UNAUTHENTICATED) {
    return new AppError(code, message, HttpStatus.UNAUTHORIZED);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown) {
    return new AppError(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static validation(message: string, details?: unknown) {
    return new AppError(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}
