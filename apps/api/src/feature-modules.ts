import { RealtimeModule } from './realtime/realtime.gateway';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AutomationModule } from './modules/automation/automation.module';
import { BrandingModule } from './modules/branding/branding.module';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PortalModule } from './modules/portal/portal.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { BookingModule } from './modules/booking/booking.module';
import { FranchiseModule } from './modules/franchise/franchise.module';
import { HqModule } from './modules/hq/hq.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { SupportModule } from './modules/support/support.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RetentionModule } from './modules/retention/retention.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.controller';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { OffersModule } from './modules/offers/offers.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PackagesModule } from './modules/packages/packages.module';
import { QueueModule } from './modules/queue/queue.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { IntegrationSettingsModule } from './modules/integration-settings/integration-settings.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

/** Business modules of the modular monolith (spec section 9). */
export const FEATURE_MODULES = [
  HealthModule,
  RbacModule,
  AuthModule,
  TenantsModule,
  BranchesModule,
  UsersModule,
  SettingsModule,
  IntegrationSettingsModule,
  FilesModule,
  CatalogModule,
  OnboardingModule,
  RealtimeModule,
  CustomersModule,
  AppointmentsModule,
  SessionsModule,
  QueueModule,
  LedgerModule,
  PackagesModule,
  MembershipsModule,
  OffersModule,
  InventoryModule,
  BillingModule,
  ExpensesModule,
  ReportsModule,
  NotificationsModule,
  FeedbackModule,
  RetentionModule,
  CampaignsModule,
  AutomationModule,
  BrandingModule,
  HqModule,
  FranchiseModule,
  SubscriptionModule,
  SupportModule,
  ApiKeysModule,
  AdminModule,
  BookingModule,
  AiModule,
  AnalyticsModule,
  PortalModule,
];
