# TherapyOS mobile

One Flutter codebase that ships two apps:

| Flavor | Entry point | For | Main screens |
| --- | --- | --- | --- |
| `staff` | `lib/main_staff.dart` | Therapists, reception, managers | My day (therapists), live session with timer + notes, today's sessions, walk-in queue, profile |
| `customer` | `lib/main_customer.dart` | Clients of one business | OTP sign-in, home, nearby centres, booking, visits, packages / memberships / shop, invoices + online payment, offers, profile |

Both talk to the same REST API (`/api/v1`). The staff app signs in with email/phone + password (`/auth/*`);
the customer app signs in with a WhatsApp/SMS OTP (`/portal/auth/*`) and only sees its own data
(customer tokens are rejected by every staff endpoint and vice versa). The customer app requires the
business to have the **Customer app** feature on its plan.

## Prerequisites

- Flutter 3.35+ (`flutter doctor` clean for the platforms you target)
- The API running locally (`pnpm dev` at the repo root, API on port 4000) with demo data seeded

## Run

```bash
cd apps/mobile
flutter pub get

# Android emulator (reaches the host API on 10.0.2.2:4000 automatically)
flutter run --flavor staff    -t lib/main_staff.dart
flutter run --flavor customer -t lib/main_customer.dart

# Browser (quick UI check; online card payment is mobile-only)
flutter run -d chrome -t lib/main_customer.dart --dart-define=API_URL=http://localhost:4000

# Physical phone on the same Wi-Fi
flutter run --flavor customer -t lib/main_customer.dart --dart-define=API_URL=http://192.168.1.20:4000
```

Build-time settings (`--dart-define`):

| Key | Default | Purpose |
| --- | --- | --- |
| `API_URL` | `http://10.0.2.2:4000` on Android, else `http://localhost:4000` | API origin |
| `TENANT_SLUG` | `serenity-wellness` | Business the customer app belongs to (white-label builds set their own) |
| `APP_NAME` | `TherapyOS Staff` / `TherapyOS` | Title shown before sign-in |

## Demo accounts

- Staff (password `Demo@12345`): therapists `arjun@serenity.demo`, `lakshmi@serenity.demo` (Indiranagar),
  `deepa@serenity.demo` (Koramangala); front desk `reception@serenity.demo`; manager `manager@serenity.demo`;
  owner `owner@serenity.demo`.
- Customer: any phone number. Outside production the API returns the OTP and the app shows it as
  "Test mode code". Existing demo client: `98450 10036` (Aarav Kapoor). A new number goes through a
  one-screen sign-up.

## Payments

`/portal/purchase` and `/portal/invoices/:id/pay` return a gateway order:

- **Mock provider** (`PAYMENT_PROVIDER=mock`, the default in development): the app asks for confirmation
  and settles through `/portal/payments/:id/mock-complete` (disabled in production).
- **Razorpay**: the native checkout (`razorpay_flutter`) opens on Android/iOS; the signed result is
  verified by `/portal/payments/verify` before the invoice is marked paid. The webhook remains the source
  of truth if the app is closed mid-payment.

## Release builds

```bash
flutter build appbundle --flavor staff    -t lib/main_staff.dart    --dart-define=API_URL=https://api.example.com
flutter build appbundle --flavor customer -t lib/main_customer.dart --dart-define=API_URL=https://api.example.com --dart-define=TENANT_SLUG=your-business
```

- Android application IDs: `com.rkyves.therapyos_mobile.staff` and `.customer`. Configure a real upload key
  in `android/app/build.gradle.kts` before publishing.
- iOS: flavors are selected by entry point (`-t`). For two App Store apps, add `staff` / `customer` schemes
  and bundle IDs in Xcode (macOS only).
- Tokens are kept in the Keychain / Android Keystore (`flutter_secure_storage`), separately per flavor.

## Checks

```bash
flutter analyze
flutter test
```

Tests cover the API client (envelope unwrapping, error mapping, single-flight token refresh, session
expiry), formatting helpers, the customer OTP sign-in / sign-up flow and the therapist's day
(starting an appointment into a live session, timer behaviour).
