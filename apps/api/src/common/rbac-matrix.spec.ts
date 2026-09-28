import { ALL_PERMISSIONS, PERMISSIONS as P, ROLE_TEMPLATES } from '@therapyos/types';

const can = (role: keyof typeof ROLE_TEMPLATES, permission: string) => ROLE_TEMPLATES[role].permissions.includes(permission as never);

describe('system role templates', () => {
  it('only grant permissions that exist', () => {
    for (const [role, t] of Object.entries(ROLE_TEMPLATES)) {
      const unknown = t.permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
      expect({ role, unknown }).toEqual({ role, unknown: [] });
    }
  });

  it('never grant the same permission twice', () => {
    for (const [role, t] of Object.entries(ROLE_TEMPLATES)) {
      expect({ role, size: new Set(t.permissions).size }).toEqual({ role, size: t.permissions.length });
    }
  });

  it('give the owner everything and keep billing and API keys owner-only', () => {
    expect(ROLE_TEMPLATES.OWNER.permissions).toEqual(ALL_PERMISSIONS);
    expect(can('HQ_ADMIN', P.SUBSCRIPTION_MANAGE)).toBe(false);
    expect(can('HQ_ADMIN', P.API_KEY_MANAGE)).toBe(false);
    expect(can('HQ_ADMIN', P.AI_ASSISTANT_USE)).toBe(true);
  });

  it.each([
    ['RECEPTIONIST', [P.REPORTS_FINANCIAL, P.EXPENSE_MANAGE, P.USER_MANAGE, P.AI_ASSISTANT_USE, P.ANALYTICS_READ, P.PAYMENT_REFUND, P.INVOICE_VOID, P.LEDGER_READ]],
    ['THERAPIST', [P.INVOICE_READ, P.CUSTOMER_CREATE, P.CUSTOMER_CONTACT_VIEW, P.SESSION_READ, P.QUEUE_MANAGE, P.REPORTS_READ, P.PAYMENT_CREATE]],
    ['ACCOUNTANT', [P.APPOINTMENT_CREATE, P.CUSTOMER_READ, P.SESSION_MANAGE, P.USER_MANAGE]],
    ['INVENTORY_MANAGER', [P.INVOICE_READ, P.CUSTOMER_READ, P.REPORTS_FINANCIAL]],
    ['BRANCH_MANAGER', [P.SUBSCRIPTION_MANAGE, P.API_KEY_MANAGE, P.HQ_DASHBOARD, P.AI_ASSISTANT_USE, P.USER_MANAGE]],
    ['AREA_MANAGER', [P.SUBSCRIPTION_MANAGE, P.API_KEY_MANAGE, P.AI_ASSISTANT_USE]],
  ] as const)('%s is denied sensitive permissions', (role, denied) => {
    expect(denied.filter((p) => can(role, p))).toEqual([]);
  });

  it('lets every front-line role do its job', () => {
    expect(can('RECEPTIONIST', P.POS_USE) && can('RECEPTIONIST', P.QUEUE_MANAGE) && can('RECEPTIONIST', P.APPOINTMENT_CREATE)).toBe(true);
    expect(can('THERAPIST', P.SESSION_READ_OWN) && can('THERAPIST', P.SESSION_MANAGE) && can('THERAPIST', P.SESSION_NOTES)).toBe(true);
    expect(can('BRANCH_MANAGER', P.ANALYTICS_READ) && can('BRANCH_MANAGER', P.REPORTS_FINANCIAL)).toBe(true);
    expect(can('AREA_MANAGER', P.HQ_DASHBOARD) && can('AREA_MANAGER', P.INVENTORY_TRANSFER_APPROVE)).toBe(true);
  });
});
