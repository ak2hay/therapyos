'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type DefaultValues, type FieldValues, type Resolver } from 'react-hook-form';
import type { ZodTypeAny, z } from 'zod';

/** react-hook-form bound to a shared @therapyos/validation schema. */
export function useZodForm<S extends ZodTypeAny>(schema: S, defaultValues?: DefaultValues<z.input<S>>) {
  return useForm<z.input<S> & FieldValues, unknown, z.output<S> & FieldValues>({
    resolver: zodResolver(schema as never) as unknown as Resolver<z.input<S> & FieldValues, unknown, z.output<S> & FieldValues>,
    defaultValues,
  });
}

export function fieldError(errors: Record<string, any>, name: string): string | undefined {
  const parts = name.split('.');
  let cur: any = errors;
  for (const p of parts) cur = cur?.[p];
  return cur?.message as string | undefined;
}
