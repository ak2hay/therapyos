import type { PageMeta } from '@therapyos/types';

export interface PageArgs {
  page: number;
  pageSize: number;
}

export function pageArgs({ page, pageSize }: PageArgs) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export class PagedResult<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: PageMeta,
  ) {}
}

export function paged<T>(items: T[], total: number, { page, pageSize }: PageArgs): PagedResult<T> {
  return new PagedResult(items, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}
