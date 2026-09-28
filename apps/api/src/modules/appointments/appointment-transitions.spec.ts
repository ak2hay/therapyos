import { APPOINTMENT_TRANSITIONS, assertTransition } from './appointments.service';

describe('appointment lifecycle', () => {
  it('allows the normal visit path', () => {
    expect(() => {
      assertTransition('BOOKED', 'CONFIRMED');
      assertTransition('CONFIRMED', 'CHECKED_IN');
      assertTransition('CHECKED_IN', 'IN_PROGRESS');
      assertTransition('IN_PROGRESS', 'COMPLETED');
    }).not.toThrow();
  });

  it('treats a no-op transition as allowed', () => {
    expect(() => assertTransition('COMPLETED', 'COMPLETED')).not.toThrow();
  });

  it.each([
    ['COMPLETED', 'CANCELLED'],
    ['CANCELLED', 'BOOKED'],
    ['NO_SHOW', 'CHECKED_IN'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['BOOKED', 'IN_PROGRESS'],
  ] as const)('rejects %s -> %s with INVALID_STATE', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('keeps terminal states terminal', () => {
    expect(APPOINTMENT_TRANSITIONS.COMPLETED).toEqual([]);
    expect(APPOINTMENT_TRANSITIONS.CANCELLED).toEqual([]);
    expect(APPOINTMENT_TRANSITIONS.NO_SHOW).toEqual([]);
  });
});
