import { Prisma } from '@prisma/client';
import { escapeLikeFilters } from './prisma.service';

describe('escapeLikeFilters', () => {
  it('escapes LIKE wildcards in contains/startsWith/endsWith, including nested and OR filters', () => {
    const where = {
      tenantId: 't1',
      OR: [{ name: { contains: '50%_off', mode: 'insensitive' } }, { phone: { startsWith: 'a\\b' } }],
      customer: { is: { email: { endsWith: '_x' } } },
    };
    expect(escapeLikeFilters(where)).toEqual({
      tenantId: 't1',
      OR: [{ name: { contains: '50\\%\\_off', mode: 'insensitive' } }, { phone: { startsWith: 'a\\\\b' } }],
      customer: { is: { email: { endsWith: '\\_x' } } },
    });
  });

  it('leaves other values untouched and does not mutate the input', () => {
    const date = new Date('2026-09-01');
    const amount = new Prisma.Decimal('10.50');
    const where = { name: '100%', createdAt: { gte: date }, total: { gt: amount }, id: { in: ['a_b'] } };
    const out = escapeLikeFilters(where);
    expect(out).toEqual(where);
    expect(out.createdAt.gte).toBe(date);
    expect(out.total.gt).toBe(amount);
    expect(where.name).toBe('100%');
  });
});
