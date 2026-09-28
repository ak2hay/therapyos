const values = <T extends Record<string, string>>(o: T) => Object.values(o) as T[keyof T][];

export const TenantStatus = {
  ONBOARDING: 'ONBOARDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export const BusinessType = {
  AYURVEDA: 'AYURVEDA',
  MASSAGE: 'MASSAGE',
  WELLNESS: 'WELLNESS',
  PHYSIOTHERAPY: 'PHYSIOTHERAPY',
  FOOT_THERAPY: 'FOOT_THERAPY',
  ALTERNATIVE_THERAPY: 'ALTERNATIVE_THERAPY',
  OTHER: 'OTHER',
} as const;
export type BusinessType = (typeof BusinessType)[keyof typeof BusinessType];
export const BUSINESS_TYPES = values(BusinessType);

export const RecordStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

export const UserStatus = { ACTIVE: 'ACTIVE', INVITED: 'INVITED', DISABLED: 'DISABLED' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const SystemRole = {
  OWNER: 'OWNER',
  HQ_ADMIN: 'HQ_ADMIN',
  AREA_MANAGER: 'AREA_MANAGER',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  RECEPTIONIST: 'RECEPTIONIST',
  THERAPIST: 'THERAPIST',
  ACCOUNTANT: 'ACCOUNTANT',
  INVENTORY_MANAGER: 'INVENTORY_MANAGER',
} as const;
export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export const CustomerSource = {
  WALK_IN: 'WALK_IN',
  WEBSITE: 'WEBSITE',
  WHATSAPP: 'WHATSAPP',
  REFERRAL: 'REFERRAL',
  INSTAGRAM: 'INSTAGRAM',
  GOOGLE: 'GOOGLE',
  CAMPAIGN: 'CAMPAIGN',
  CUSTOMER_APP: 'CUSTOMER_APP',
  OTHER: 'OTHER',
} as const;
export type CustomerSource = (typeof CustomerSource)[keyof typeof CustomerSource];
export const CUSTOMER_SOURCES = values(CustomerSource);

export const Gender = { MALE: 'MALE', FEMALE: 'FEMALE', OTHER: 'OTHER', UNDISCLOSED: 'UNDISCLOSED' } as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

export const CustomerStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE', BLOCKED: 'BLOCKED' } as const;
export type CustomerStatus = (typeof CustomerStatus)[keyof typeof CustomerStatus];

export const CustomerSegment = {
  NEW: 'NEW',
  ACTIVE: 'ACTIVE',
  LOYAL: 'LOYAL',
  AT_RISK: 'AT_RISK',
  INACTIVE: 'INACTIVE',
  CHURNED: 'CHURNED',
  VIP: 'VIP',
} as const;
export type CustomerSegment = (typeof CustomerSegment)[keyof typeof CustomerSegment];
export const CUSTOMER_SEGMENTS = values(CustomerSegment);

export const CommissionType = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_PER_SESSION: 'FIXED_PER_SESSION',
  TIERED: 'TIERED',
  NONE: 'NONE',
} as const;
export type CommissionType = (typeof CommissionType)[keyof typeof CommissionType];

export const ScheduleExceptionType = {
  LEAVE: 'LEAVE',
  HOLIDAY: 'HOLIDAY',
  SPECIAL_SHIFT: 'SPECIAL_SHIFT',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ScheduleExceptionType = (typeof ScheduleExceptionType)[keyof typeof ScheduleExceptionType];

export const AppointmentStatus = {
  BOOKED: 'BOOKED',
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type AppointmentStatus = (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export const AppointmentSource = {
  WALK_IN: 'WALK_IN',
  RECEPTION: 'RECEPTION',
  WEBSITE: 'WEBSITE',
  CUSTOMER_APP: 'CUSTOMER_APP',
  WHATSAPP: 'WHATSAPP',
  PHONE: 'PHONE',
} as const;
export type AppointmentSource = (typeof AppointmentSource)[keyof typeof AppointmentSource];
export const APPOINTMENT_SOURCES = values(AppointmentSource);

export const QueueStatus = {
  WAITING: 'WAITING',
  CALLED: 'CALLED',
  ASSIGNED: 'ASSIGNED',
  IN_SERVICE: 'IN_SERVICE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type QueueStatus = (typeof QueueStatus)[keyof typeof QueueStatus];

export const SessionStatus = {
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const ItemType = {
  SERVICE: 'SERVICE',
  PRODUCT: 'PRODUCT',
  PACKAGE: 'PACKAGE',
  MEMBERSHIP: 'MEMBERSHIP',
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const PaymentMethod = {
  CASH: 'CASH',
  UPI: 'UPI',
  CARD: 'CARD',
  RAZORPAY: 'RAZORPAY',
  BANK_TRANSFER: 'BANK_TRANSFER',
  PACKAGE: 'PACKAGE',
  MEMBERSHIP: 'MEMBERSHIP',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PAYMENT_METHODS = values(PaymentMethod);

export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const InventoryTxnType = {
  PURCHASE: 'PURCHASE',
  SALE: 'SALE',
  CONSUMPTION: 'CONSUMPTION',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  ADJUSTMENT: 'ADJUSTMENT',
  RETURN: 'RETURN',
  DAMAGE: 'DAMAGE',
} as const;
export type InventoryTxnType = (typeof InventoryTxnType)[keyof typeof InventoryTxnType];

export const ExpenseCategory = {
  RENT: 'RENT',
  SALARY: 'SALARY',
  ELECTRICITY: 'ELECTRICITY',
  INTERNET: 'INTERNET',
  MARKETING: 'MARKETING',
  SUPPLIES: 'SUPPLIES',
  MAINTENANCE: 'MAINTENANCE',
  INVENTORY: 'INVENTORY',
  OTHER: 'OTHER',
} as const;
export type ExpenseCategory = (typeof ExpenseCategory)[keyof typeof ExpenseCategory];
export const EXPENSE_CATEGORIES = values(ExpenseCategory);

export const OfferType = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
  BUY_ONE_GET_ONE: 'BUY_ONE_GET_ONE',
  PACKAGE_BONUS: 'PACKAGE_BONUS',
  MEMBERSHIP_BONUS: 'MEMBERSHIP_BONUS',
} as const;
export type OfferType = (typeof OfferType)[keyof typeof OfferType];

export const FeedbackSource = {
  IN_APP: 'IN_APP',
  QR: 'QR',
  WHATSAPP: 'WHATSAPP',
  GOOGLE: 'GOOGLE',
  MANUAL: 'MANUAL',
} as const;
export type FeedbackSource = (typeof FeedbackSource)[keyof typeof FeedbackSource];

export const NotificationChannel = {
  PUSH: 'PUSH',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  IN_APP: 'IN_APP',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationEvent = {
  APPOINTMENT_BOOKED: 'APPOINTMENT_BOOKED',
  APPOINTMENT_REMINDER: 'APPOINTMENT_REMINDER',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  SESSION_COMPLETED: 'SESSION_COMPLETED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PACKAGE_EXPIRING: 'PACKAGE_EXPIRING',
  MEMBERSHIP_EXPIRING: 'MEMBERSHIP_EXPIRING',
  BIRTHDAY: 'BIRTHDAY',
  WIN_BACK: 'WIN_BACK',
  LOW_STOCK: 'LOW_STOCK',
  FEEDBACK_REQUEST: 'FEEDBACK_REQUEST',
  MARKETING: 'MARKETING',
} as const;
export type NotificationEvent = (typeof NotificationEvent)[keyof typeof NotificationEvent];
export const NOTIFICATION_EVENTS = values(NotificationEvent);

export const FeatureFlagKey = {
  WHATSAPP_ENABLED: 'WHATSAPP_ENABLED',
  MEMBERSHIP_ENABLED: 'MEMBERSHIP_ENABLED',
  INVENTORY_ENABLED: 'INVENTORY_ENABLED',
  PACKAGES_ENABLED: 'PACKAGES_ENABLED',
  ADVANCED_ANALYTICS: 'ADVANCED_ANALYTICS',
  MULTI_BRANCH: 'MULTI_BRANCH',
  COMMISSIONS: 'COMMISSIONS',
  RETENTION_AUTOMATION: 'RETENTION_AUTOMATION',
  CUSTOMER_APP: 'CUSTOMER_APP',
  FRANCHISE: 'FRANCHISE',
  API_ACCESS: 'API_ACCESS',
  WHITE_LABEL: 'WHITE_LABEL',
  AI_ASSISTANT: 'AI_ASSISTANT',
} as const;
export type FeatureFlagKey = (typeof FeatureFlagKey)[keyof typeof FeatureFlagKey];
export const FEATURE_FLAG_KEYS = values(FeatureFlagKey);

export const SubscriptionStatus = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const TenantSettingKey = {
  CURRENCY: 'CURRENCY',
  TIMEZONE: 'TIMEZONE',
  TAX_MODE: 'TAX_MODE',
  INVOICE_PREFIX: 'INVOICE_PREFIX',
  APPOINTMENT_BUFFER: 'APPOINTMENT_BUFFER',
  DEFAULT_APPOINTMENT_DURATION: 'DEFAULT_APPOINTMENT_DURATION',
  WHATSAPP_ENABLED: 'WHATSAPP_ENABLED',
  THERAPIST_CAN_VIEW_CUSTOMER_PHONE: 'THERAPIST_CAN_VIEW_CUSTOMER_PHONE',
  ROUNDING: 'ROUNDING',
  PAYMENT_PROVIDERS: 'PAYMENT_PROVIDERS',
} as const;
export type TenantSettingKey = (typeof TenantSettingKey)[keyof typeof TenantSettingKey];
