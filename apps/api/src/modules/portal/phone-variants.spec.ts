import { phoneVariants } from './portal.module';

describe('phoneVariants', () => {
  it.each([
    ['98450 10036', '+919845010036'],
    ['9845010036', '+919845010036'],
    ['09845010036', '+919845010036'],
    ['919845010036', '+919845010036'],
    ['+91 98450-10036', '+919845010036'],
    ['+14155550123', '+14155550123'],
  ])('normalises %s to %s', (input, e164) => {
    expect(phoneVariants(input).e164).toBe(e164);
  });

  it('matches every stored form of the same number', () => {
    expect(phoneVariants('98450 10036').all).toEqual(expect.arrayContaining(['9845010036', '+919845010036', '919845010036']));
  });
});
