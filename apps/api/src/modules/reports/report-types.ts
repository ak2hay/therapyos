export type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date';

export interface ReportColumn {
  key: string;
  label: string;
  type?: ColumnType;
}

export interface ReportTable {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
}

export interface ReportMetric {
  key: string;
  label: string;
  value: number;
  type?: ColumnType;
  hint?: string;
}

export interface ReportSeries {
  title: string;
  /** Keys of each point to plot, with labels. */
  lines: { key: string; label: string; type?: ColumnType }[];
  points: Record<string, string | number>[];
}

/** One shape for every report, so the web renders and the exporter writes them generically. */
export interface Report {
  key: string;
  title: string;
  from: string;
  to: string;
  branchId: string | null;
  metrics: ReportMetric[];
  series?: ReportSeries;
  tables: ReportTable[];
}

export const REPORTS = {
  sales: { title: 'Sales', financial: false },
  services: { title: 'Services', financial: false },
  therapists: { title: 'Therapist performance', financial: false },
  customers: { title: 'Customers', financial: false },
  appointments: { title: 'Appointments', financial: false },
  packages: { title: 'Packages & memberships', financial: false },
  offers: { title: 'Offers & coupons', financial: false },
  inventory: { title: 'Inventory', financial: false },
  expenses: { title: 'Expenses', financial: true },
  pnl: { title: 'Profit & loss', financial: true },
} as const;
export type ReportKey = keyof typeof REPORTS;
