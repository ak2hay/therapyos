export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tenantId: string | null;
  tenantName?: string;
  tenantSlug?: string;
  tenantStatus?: string;
  roles: string[];
  permissions: string[];
  branchIds: string[];
  allBranches: boolean;
  therapistId?: string | null;
  isPlatformAdmin: boolean;
  features: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const DATE_PRESETS = ['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'custom'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
