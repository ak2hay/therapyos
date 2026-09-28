import { HttpStatus, PipeTransform } from '@nestjs/common';
import { ZodTypeAny, z } from 'zod';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const first = details[0];
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Validation failed.',
        HttpStatus.BAD_REQUEST,
        details,
      );
    }
    return result.data;
  }
}

export const Zod = <T extends ZodTypeAny>(schema: T) => new ZodPipe(schema);
