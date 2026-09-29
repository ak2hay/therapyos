import {
  BarChart3,
  Bot,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Crown,
  FileText,
  Gift,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListOrdered,
  Megaphone,
  Network,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Sparkles,
  Star,
  Stethoscope,
  Sun,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { FeatureFlagKey as F, PERMISSIONS as P } from '@therapyos/types';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  perm?: string | string[];
  feature?: string;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/today', label: 'My Day', icon: Sun, perm: P.SESSION_READ_OWN },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/customers', label: 'Customers', icon: Users, perm: P.CUSTOMER_READ },
      { href: '/appointments', label: 'Appointments', icon: CalendarDays, perm: P.APPOINTMENT_READ },
      { href: '/queue', label: 'Queue', icon: ListOrdered, perm: P.QUEUE_READ },
      { href: '/sessions', label: 'Sessions', icon: ClipboardList, perm: [P.SESSION_READ, P.SESSION_READ_OWN] },
    ],
  },
  {
    title: 'Revenue',
    items: [
      { href: '/pos', label: 'POS', icon: ShoppingCart, perm: P.POS_USE },
      { href: '/invoices', label: 'Invoices', icon: Receipt, perm: P.INVOICE_READ },
      { href: '/payments', label: 'Payments', icon: CreditCard, perm: P.PAYMENT_READ },
      { href: '/packages', label: 'Packages', icon: Package, perm: P.PACKAGE_READ, feature: F.PACKAGES_ENABLED },
      { href: '/memberships', label: 'Memberships', icon: Crown, perm: P.MEMBERSHIP_READ, feature: F.MEMBERSHIP_ENABLED },
      { href: '/offers', label: 'Offers & Coupons', icon: Gift, perm: P.OFFER_READ },
    ],
  },
  {
    title: 'Catalogue',
    items: [
      { href: '/services', label: 'Services', icon: Sparkles, perm: P.SERVICE_READ },
      { href: '/therapists', label: 'Therapists', icon: Stethoscope, perm: P.THERAPIST_READ },
    ],
  },
  {
    title: 'Management',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Boxes, perm: P.INVENTORY_READ, feature: F.INVENTORY_ENABLED },
      { href: '/expenses', label: 'Expenses', icon: Wallet, perm: P.EXPENSE_READ },
      { href: '/reports', label: 'Reports', icon: FileText, perm: P.REPORTS_READ },
      { href: '/analytics', label: 'Analytics', icon: BarChart3, perm: P.ANALYTICS_READ, feature: F.ADVANCED_ANALYTICS },
      { href: '/hq', label: 'HQ Overview', icon: Building2, perm: P.HQ_DASHBOARD, feature: F.MULTI_BRANCH },
    ],
  },
  {
    title: 'Growth',
    items: [
      { href: '/marketing', label: 'Marketing & Retention', icon: Megaphone, perm: [P.CAMPAIGN_READ, P.RETENTION_READ] },
      { href: '/feedback', label: 'Feedback', icon: Star, perm: P.FEEDBACK_READ },
      { href: '/assistant', label: 'AI Assistant', icon: Bot, perm: P.AI_ASSISTANT_USE, feature: F.AI_ASSISTANT },
    ],
  },
  {
    title: 'Business',
    items: [
      { href: '/franchise', label: 'Franchise', icon: Network, perm: P.FRANCHISE_READ, feature: F.FRANCHISE },
      { href: '/branches', label: 'Branches', icon: Building2, perm: P.BRANCH_MANAGE },
      { href: '/staff', label: 'Staff & Roles', icon: UserCog, perm: P.USER_READ },
      { href: '/settings', label: 'Settings', icon: Settings, perm: [P.SETTINGS_MANAGE, P.TENANT_UPDATE] },
      { href: '/support', label: 'Support', icon: LifeBuoy, perm: P.SUPPORT_USE },
    ],
  },
];

export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/tenants', label: 'Tenants', icon: Building2 },
  { href: '/admin/plans', label: 'Plans', icon: Crown },
  { href: '/admin/flags', label: 'Feature Flags', icon: HeartHandshake },
  { href: '/admin/integrations', label: 'Integrations', icon: KeyRound },
  { href: '/admin/settings', label: 'Platform Settings', icon: Settings },
  { href: '/admin/support', label: 'Support', icon: LifeBuoy },
  { href: '/admin/system', label: 'System Health', icon: BarChart3 },
];
