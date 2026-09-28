# Rkyves TherapyOS
## Detailed Product Structure & Technical Architecture
### Version 1.0 — September 2026

---

## 1. Executive Summary

**TherapyOS** is a multi-tenant SaaS platform by Rkyves for managing therapy, wellness, Ayurveda, massage, physiotherapy, alternative-therapy and similar service businesses.

The product is designed as a **Business Operating System**, not merely an appointment-booking application.

It combines:

- Customer/CRM management
- Walk-in and queue management
- Appointment scheduling
- Therapy/service catalogue
- Therapist/staff management
- Packages and memberships
- POS and billing
- Payments
- Inventory
- Branch management
- Customer retention
- WhatsApp communication
- Business analytics
- Franchise/HQ management
- Subscription billing for TherapyOS itself

The product should be generic enough for independent clinics and small centers while scaling to multi-branch and franchise businesses.

---

# 2. Product Vision

## Positioning

> **Run your entire therapy and wellness business from one platform.**

TherapyOS should help an owner answer:

1. How much did my business earn today?
2. Which branch is performing best?
3. How many customers visited?
4. How many are returning?
5. Which therapists generated the most sessions?
6. Which packages are selling?
7. Which packages are expiring?
8. Which customers have stopped visiting?
9. How much inventory is available?
10. Which services generate the most revenue?
11. How much commission should each therapist receive?
12. Which branch needs attention?

---

# 3. Target Customers

## Primary

- Massage centers
- Ayurveda centers
- Abhyanga centers
- Wellness clinics
- Foot therapy centers
- Physiotherapy centers
- Alternative therapy centers
- Holistic wellness centers
- Small therapy clinics
- Multi-branch therapy chains
- Franchise wellness businesses

## Secondary

- Spa/wellness businesses
- Beauty + therapy businesses
- Fitness recovery centers
- Corporate wellness providers

---

# 4. Product Scope

## Core Modules

```text
TherapyOS
│
├── Authentication & Identity
├── Tenant / Business Management
├── Branch Management
├── User & Role Management
├── Customer CRM
├── Services
├── Appointments
├── Walk-in / Queue
├── Therapy Sessions
├── Therapists / Staff
├── Packages
├── Memberships
├── POS / Billing
├── Payments
├── Inventory
├── Expenses
├── Offers / Coupons
├── Customer Feedback
├── Notifications
├── WhatsApp
├── Reports
├── Analytics
├── Customer Retention
├── Franchise / HQ
├── Subscription Billing
├── Audit Logs
├── Support
└── System Administration
```

---

# 5. User Types

## Platform Level

### Rkyves Super Admin

Responsible for the entire SaaS platform.

Capabilities:

- Tenant management
- Subscription plans
- Billing
- Feature flags
- System health
- Platform analytics
- Support
- Tenant suspension
- Audit access

---

## Tenant Level

### Business Owner

Can manage the entire business.

### HQ Admin

Can manage multiple branches.

### Area Manager

Can manage assigned branches.

### Branch Manager

Can manage one branch.

### Receptionist

Can:

- Register customers
- Create appointments
- Manage queue
- Process billing
- Check-in customers

### Therapist

Can:

- See assigned sessions
- Start sessions
- Complete sessions
- Add permitted service notes
- View relevant customer history

### Accountant

Can:

- Payments
- Expenses
- Reports
- Reconciliation

### Inventory Manager

Can:

- Stock
- Purchases
- Transfers
- Adjustments

---

# 6. Multi-Tenant Architecture

TherapyOS must be multi-tenant from day one.

```text
Rkyves Platform
│
├── Tenant A
│   ├── Branch 1
│   ├── Branch 2
│   └── Branch 3
│
├── Tenant B
│   └── Branch 1
│
└── Tenant C
    ├── Branch 1
    ├── Branch 2
    └── Branch 3
```

Every tenant-owned record should carry:

```text
tenant_id
```

Branch-level records should also carry:

```text
branch_id
```

Examples:

```text
customers
    tenant_id
    branch_id

appointments
    tenant_id
    branch_id

payments
    tenant_id
    branch_id

inventory
    tenant_id
    branch_id
```

## Tenant Isolation Rules

The backend must never trust `tenant_id` sent by the client.

Tenant context should be derived from:

```text
Authenticated User
        ↓
JWT / Session
        ↓
Tenant Context
        ↓
Authorization Middleware
        ↓
Database Query
```

Never allow a normal client to arbitrarily select another tenant.

---

# 7. High-Level Architecture

```text
                         INTERNET
                             │
                             ▼
                    CDN / WAF / DNS
                             │
                             ▼
                     API Gateway / LB
                             │
             ┌───────────────┴────────────────┐
             │                                │
             ▼                                ▼
       Web Application                  Mobile Applications
       Admin / Reception               Future Customer App
             │                                │
             └───────────────┬────────────────┘
                             ▼
                     Backend API Layer
                             │
       ┌─────────────────────┼──────────────────────┐
       │                     │                      │
       ▼                     ▼                      ▼
 Authentication       Business Services       Integrations
       │                     │                      │
       │              ┌──────┼──────┐        ┌──────┼──────┐
       │              │      │      │        │      │      │
       │              CRM   POS   Booking   WhatsApp Razorpay
       │
       └──────────────────────┬─────────────────────┘
                              │
                ┌─────────────┼──────────────┐
                │             │              │
                ▼             ▼              ▼
             PostgreSQL      Redis       Object Storage
                │             │              │
                ▼             ▼              ▼
             Primary DB     Cache       Documents/Media
                              │
                              ▼
                       Background Workers
                              │
              ┌───────────────┼────────────────┐
              │               │                │
              ▼               ▼                ▼
        Notifications     Analytics       Scheduled Jobs
```

---

# 8. Recommended Technology Stack

The architecture should align with Rkyves/Cullinos development patterns where practical.

## Frontend

### Web Admin

Recommended:

- React
- Next.js
- TypeScript
- Tailwind CSS
- Component library
- React Query / TanStack Query
- Zod
- React Hook Form

Primary users:

- Owner
- HQ
- Manager
- Receptionist
- Accountant
- Inventory Manager

---

## Mobile

Recommended:

- Flutter
- Dart

Potential applications:

```text
TherapyOS Staff App
TherapyOS Customer App
TherapyOS Therapist App
```

Initially, staff can be supported through responsive web.

---

## Backend

Recommended:

- Node.js
- TypeScript
- NestJS or structured Express architecture

Preferred for a growing product:

**NestJS**

Reasons:

- Modular architecture
- Dependency injection
- Guards
- Validation
- Structured services
- Good enterprise organization

---

## Database

Primary:

**PostgreSQL**

Why:

- Relational business data
- Strong consistency
- Transactions
- Reporting
- Constraints
- Excellent SaaS fit

---

## Cache

**Redis**

Use for:

- Sessions
- Rate limits
- OTP state
- Queue state
- Short-lived cache
- Distributed locks
- Job queues

---

## Object Storage

S3-compatible storage:

- AWS S3
- Azure Blob
- Cloudflare R2
- GCP Cloud Storage

Store:

- Logos
- Customer documents where applicable
- Invoice PDFs
- Product images
- Business documents

Do not store large files directly in PostgreSQL.

---

## Background Jobs

Recommended:

- BullMQ
- Redis

Jobs:

```text
WhatsApp notifications
Appointment reminders
Package expiry reminders
Membership renewal
Invoice generation
Analytics aggregation
Retention campaigns
Inventory alerts
Daily reports
```

---

# 9. Backend Modular Architecture

Use a modular monolith for V1 rather than microservices.

```text
backend/
│
├── src/
│   ├── auth/
│   ├── tenants/
│   ├── users/
│   ├── roles/
│   ├── branches/
│   ├── customers/
│   ├── services/
│   ├── therapists/
│   ├── appointments/
│   ├── queue/
│   ├── sessions/
│   ├── packages/
│   ├── memberships/
│   ├── pos/
│   ├── invoices/
│   ├── payments/
│   ├── inventory/
│   ├── expenses/
│   ├── offers/
│   ├── coupons/
│   ├── notifications/
│   ├── whatsapp/
│   ├── reports/
│   ├── analytics/
│   ├── retention/
│   ├── franchises/
│   ├── subscriptions/
│   ├── audit/
│   ├── support/
│   ├── common/
│   └── config/
│
├── migrations/
├── tests/
└── main.ts
```

---

# 10. Why Modular Monolith for V1

Do not start with microservices.

V1 should be:

```text
Frontend
   ↓
API
   ↓
Modular Monolith
   ↓
PostgreSQL
   +
Redis
   +
Workers
```

Benefits:

- Faster development
- Easier debugging
- Lower infrastructure cost
- Easier local development
- Easier transactions
- Easier deployment

When scale requires it, modules can be extracted.

Potential future services:

```text
Notification Service
Payment Service
Analytics Service
WhatsApp Service
Search Service
```

---

# 11. Core Database Structure

## Tenant

```text
tenants
---------
id
name
legal_name
slug
logo_url
phone
email
timezone
currency
country
status
subscription_plan_id
created_at
updated_at
```

---

## Branch

```text
branches
---------
id
tenant_id
name
code
phone
email
address
city
state
pincode
latitude
longitude
timezone
opening_time
closing_time
status
created_at
updated_at
```

---

## User

```text
users
---------
id
tenant_id
name
phone
email
password_hash
status
last_login_at
created_at
updated_at
```

---

## Roles

```text
roles
---------
id
tenant_id
name
description
```

```text
permissions
---------
id
code
description
```

```text
role_permissions
---------
role_id
permission_id
```

```text
user_roles
---------
user_id
role_id
branch_id
```

---

# 12. Customer Database

```text
customers
---------
id
tenant_id
primary_branch_id
customer_code
name
phone
email
dob
gender
address
city
state
pincode
source
status
created_at
updated_at
```

Customer source:

```text
WALK_IN
WEBSITE
WHATSAPP
REFERRAL
INSTAGRAM
GOOGLE
CAMPAIGN
OTHER
```

---

# 13. Customer Timeline

Create a unified timeline:

```text
Customer
│
├── Registration
├── Appointment
├── Check-in
├── Session
├── Package purchase
├── Package redemption
├── Payment
├── Coupon
├── Feedback
├── WhatsApp communication
└── Membership
```

This is extremely useful for CRM.

---

# 14. Services

```text
services
---------
id
tenant_id
name
description
category_id
duration_minutes
base_price
tax_rate
status
created_at
updated_at
```

Branch-specific configuration:

```text
branch_services
---------
id
branch_id
service_id
price
duration_minutes
is_active
```

This allows the same service to have different prices at different branches.

---

# 15. Service Categories

Examples:

```text
Foot Therapy
Massage
Ayurveda
Head Therapy
Body Therapy
Physiotherapy
Consultation
Other
```

Categories must be configurable.

---

# 16. Therapist Management

```text
therapists
---------
id
tenant_id
user_id
employee_code
specialization
joining_date
status
commission_type
commission_value
```

Possible commission models:

```text
PERCENTAGE
FIXED_PER_SESSION
TIERED
NONE
```

---

# 17. Therapist Availability

```text
therapist_schedules
---------
id
therapist_id
branch_id
day_of_week
start_time
end_time
```

Exceptions:

```text
therapist_schedule_exceptions
---------
id
therapist_id
date
type
reason
start_time
end_time
```

Types:

```text
LEAVE
HOLIDAY
SPECIAL_SHIFT
UNAVAILABLE
```

---

# 18. Appointment Architecture

```text
appointments
---------
id
tenant_id
branch_id
customer_id
service_id
therapist_id
appointment_date
start_time
end_time
status
source
notes
created_by
created_at
updated_at
```

Statuses:

```text
BOOKED
CONFIRMED
CHECKED_IN
IN_PROGRESS
COMPLETED
CANCELLED
NO_SHOW
```

Sources:

```text
WALK_IN
RECEPTION
WEBSITE
CUSTOMER_APP
WHATSAPP
PHONE
```

---

# 19. Walk-in / Queue System

Walk-ins need a dedicated queue.

```text
queue_entries
---------
id
tenant_id
branch_id
customer_id
appointment_id
service_id
therapist_id
queue_number
status
priority
checked_in_at
called_at
started_at
completed_at
```

Statuses:

```text
WAITING
CALLED
ASSIGNED
IN_SERVICE
COMPLETED
CANCELLED
```

Queue UI:

```text
WAITING
│
├── Token 101 - Rahul
├── Token 102 - Sneha
└── Token 103 - Akash

IN SERVICE
│
├── Token 099 - Amit
└── Token 100 - Priya
```

---

# 20. Therapy Session

A session represents the actual service delivered.

```text
therapy_sessions
---------
id
tenant_id
branch_id
appointment_id
queue_entry_id
customer_id
therapist_id
service_id
started_at
completed_at
status
notes
rating
created_at
updated_at
```

Do not mix appointment and session.

### Appointment

Customer intends to visit.

### Session

Service was actually delivered.

This distinction is important for analytics.

---

# 21. Packages

```text
packages
---------
id
tenant_id
name
description
validity_days
price
status
```

Package items:

```text
package_items
---------
id
package_id
service_id
quantity
```

Customer package:

```text
customer_packages
---------
id
tenant_id
customer_id
package_id
purchase_invoice_id
purchased_at
expires_at
status
```

Usage:

```text
package_redemptions
---------
id
customer_package_id
session_id
service_id
quantity
redeemed_at
```

---

# 22. Memberships

```text
membership_plans
---------
id
tenant_id
name
price
billing_interval
duration_days
description
status
```

Customer membership:

```text
customer_memberships
---------
id
tenant_id
customer_id
membership_plan_id
started_at
expires_at
auto_renew
status
```

---

# 23. POS

POS should support:

```text
Service
Product
Package
Membership
```

Cart:

```text
carts
---------
id
tenant_id
branch_id
customer_id
status
```

Cart items:

```text
cart_items
---------
id
cart_id
item_type
item_id
quantity
unit_price
discount
tax
total
```

---

# 24. Invoicing

```text
invoices
---------
id
tenant_id
branch_id
customer_id
invoice_number
subtotal
discount
tax
rounding
total
status
issued_at
```

Invoice items:

```text
invoice_items
---------
id
invoice_id
item_type
item_id
description
quantity
unit_price
discount
tax
total
```

Statuses:

```text
DRAFT
ISSUED
PARTIALLY_PAID
PAID
CANCELLED
REFUNDED
```

---

# 25. Payments

```text
payments
---------
id
tenant_id
branch_id
invoice_id
customer_id
amount
method
provider
provider_transaction_id
status
paid_at
```

Methods:

```text
CASH
UPI
CARD
RAZORPAY
BANK_TRANSFER
PACKAGE
MEMBERSHIP
OTHER
```

Payment status:

```text
PENDING
SUCCESS
FAILED
REFUNDED
PARTIALLY_REFUNDED
```

---

# 26. Inventory

Products:

```text
products
---------
id
tenant_id
name
sku
category_id
unit
cost_price
selling_price
tax_rate
status
```

Stock:

```text
inventory_stock
---------
id
tenant_id
branch_id
product_id
quantity
reorder_level
```

Transactions:

```text
inventory_transactions
---------
id
tenant_id
branch_id
product_id
type
quantity
reference_type
reference_id
created_by
created_at
```

Types:

```text
PURCHASE
SALE
CONSUMPTION
TRANSFER_IN
TRANSFER_OUT
ADJUSTMENT
RETURN
DAMAGE
```

---

# 27. Branch Transfers

```text
inventory_transfers
---------
id
tenant_id
from_branch_id
to_branch_id
status
requested_by
approved_by
created_at
```

Items:

```text
inventory_transfer_items
---------
id
transfer_id
product_id
quantity
```

---

# 28. Expenses

```text
expenses
---------
id
tenant_id
branch_id
category
amount
description
expense_date
payment_method
created_by
```

Categories:

```text
RENT
SALARY
ELECTRICITY
INTERNET
MARKETING
SUPPLIES
MAINTENANCE
INVENTORY
OTHER
```

---

# 29. Offers

```text
offers
---------
id
tenant_id
name
description
offer_type
value
start_date
end_date
status
```

Offer types:

```text
PERCENTAGE
FIXED
BUY_ONE_GET_ONE
PACKAGE_BONUS
MEMBERSHIP_BONUS
```

---

# 30. Coupons

```text
coupons
---------
id
tenant_id
code
discount_type
discount_value
minimum_order
maximum_discount
usage_limit
per_customer_limit
start_date
end_date
status
```

---

# 31. Customer Feedback

```text
feedback
---------
id
tenant_id
branch_id
customer_id
session_id
rating
comment
source
created_at
```

Sources:

```text
IN_APP
QR
WHATSAPP
GOOGLE
MANUAL
```

---

# 32. Notifications

Central notification service.

Channels:

```text
PUSH
SMS
EMAIL
WHATSAPP
IN_APP
```

Events:

```text
APPOINTMENT_BOOKED
APPOINTMENT_REMINDER
APPOINTMENT_CANCELLED
SESSION_COMPLETED
PAYMENT_RECEIVED
PACKAGE_EXPIRING
MEMBERSHIP_EXPIRING
BIRTHDAY
WIN_BACK
LOW_STOCK
```

---

# 33. WhatsApp Architecture

Do not tightly couple WhatsApp logic to individual modules.

Use an event-based approach.

```text
Appointment Created
        │
        ▼
Domain Event
        │
        ▼
Notification Worker
        │
        ▼
WhatsApp Provider
        │
        ▼
Customer
```

Example:

```text
appointment.created
appointment.reminder_due
package.expiring
membership.expiring
customer.inactive
```

---

# 34. Customer Retention Engine

This should be a major differentiator.

Calculate:

```text
last_visit_date
visit_frequency
visit_count
average_spend
lifetime_value
package_status
membership_status
```

Customer segments:

```text
NEW
ACTIVE
LOYAL
AT_RISK
INACTIVE
CHURNED
VIP
```

Example:

```text
Customer usually visits every 21 days.

Last visit:
35 days ago.

Status:
AT_RISK
```

System can generate a campaign candidate.

---

# 35. Customer Lifetime Value

Basic formula:

```text
LTV =
Total customer revenue
```

Later:

```text
Expected LTV =
Average transaction value
×
Purchase frequency
×
Expected customer lifespan
```

Dashboard:

```text
Average LTV
₹8,420

Top 10% customer LTV
₹24,800
```

---

# 36. Analytics Architecture

Operational database should not be responsible for every complex dashboard query forever.

V1:

```text
PostgreSQL
     ↓
Indexed reporting queries
```

Later:

```text
PostgreSQL
     ↓
Event / ETL
     ↓
Analytics Store
     ↓
Dashboard
```

Potential future options:

- ClickHouse
- BigQuery
- Snowflake

For V1, PostgreSQL is sufficient.

---

# 37. Core KPIs

## Revenue

- Gross revenue
- Net revenue
- Tax
- Discounts
- Refunds
- Average transaction value

## Customer

- Total customers
- New customers
- Returning customers
- Active customers
- Inactive customers
- Retention rate
- Churn

## Operations

- Sessions
- Appointments
- No-shows
- Cancellation rate
- Average wait time
- Therapist utilization

## Packages

- Packages sold
- Package revenue
- Redemptions
- Expiring packages
- Expired packages

## Membership

- Active memberships
- New memberships
- Renewals
- Cancellations
- MRR

## Branch

- Revenue
- Sessions
- Customers
- Revenue per therapist
- Revenue per customer

---

# 38. Owner Dashboard

Recommended layout:

```text
┌──────────────────────────────────────────────────────┐
│ Dashboard                 September 2026             │
├──────────────────────────────────────────────────────┤
│ Revenue     Customers     Sessions     Avg Ticket    │
│ ₹42.8L      18,420        31,842       ₹1,344        │
├──────────────────────────────────────────────────────┤
│ Revenue Trend                                        │
│                                                      │
│                 CHART                                │
│                                                      │
├───────────────────────────┬──────────────────────────┤
│ Branch Performance        │ Service Performance      │
│                           │                          │
│ Branch A  ₹4.8L           │ Foot Therapy ₹8.2L       │
│ Branch B  ₹4.2L           │ Massage     ₹6.8L       │
│ Branch C  ₹3.9L           │ Head        ₹3.1L       │
├───────────────────────────┴──────────────────────────┤
│ Customer Retention                                   │
│ 127 customers are at risk                            │
│ Potential win-back revenue ₹1.84L                    │
├──────────────────────────────────────────────────────┤
│ Alerts                                               │
│ 42 packages expiring                                 │
│ 12 low-stock products                                │
│ 8 unpaid invoices                                    │
└──────────────────────────────────────────────────────┘
```

---

# 39. Reception Dashboard

The receptionist needs an operational screen, not analytics overload.

```text
TODAY

Appointments
Queue
Walk-ins
Check-ins
Payments
Customers
```

Main screen:

```text
Current Queue

#101 Rahul      Foot Therapy    Waiting
#102 Sneha      Massage         In Service
#103 Akash      Foot Therapy    Waiting
```

Actions:

```text
+ Walk-in
+ Appointment
Check-in
Assign Therapist
Start Session
Complete
Collect Payment
```

---

# 40. Therapist Dashboard

```text
TODAY

Sessions: 8
Completed: 5
Remaining: 3

09:30 Rahul
10:00 Sneha
10:30 Akash
11:00 Neha
```

Session actions:

```text
Start
Pause
Complete
Add Notes
```

Therapists should only see information permitted by the tenant's privacy policy and role permissions.

---

# 41. Branch Dashboard

```text
Branch Revenue
Today's Sessions
Customers
Appointments
Therapists
Queue
Inventory
Expenses
```

Branch manager should not automatically see HQ-only data.

---

# 42. HQ Dashboard

```text
All Branches

Revenue
Customers
Sessions
Packages
Memberships
Expenses
Inventory
Therapist Performance
Branch Ranking / Comparison
```

Avoid using simplistic rankings where a business wants operational context. Provide sortable/filterable performance metrics.

---

# 43. Franchise Architecture

Future module:

```text
Corporate HQ
│
├── Franchise Group
│   ├── Franchise Owner A
│   │   ├── Branch A1
│   │   └── Branch A2
│   │
│   └── Franchise Owner B
│       ├── Branch B1
│       └── Branch B2
```

Entities:

```text
franchise_groups
franchisees
franchise_contracts
franchise_fees
franchise_branches
```

Potential capabilities:

- Royalty tracking
- Franchise fee
- Branch compliance
- Corporate campaigns
- Central pricing
- Central service catalogue
- Inventory rules
- Training
- Audit

---

# 44. TherapyOS Subscription System

TherapyOS itself is a SaaS product.

```text
subscription_plans
---------
id
name
monthly_price
annual_price
max_branches
max_users
max_customers
features
status
```

Tenant subscription:

```text
tenant_subscriptions
---------
id
tenant_id
plan_id
status
start_date
renewal_date
trial_end_date
provider
provider_subscription_id
```

---

# 45. Suggested SaaS Plans

## Starter

₹999/month

```text
1 branch
5 users
Customer CRM
Appointments
Walk-ins
Billing
Basic reports
```

## Growth

₹1,999/month

```text
1 branch
15 users
Packages
Memberships
WhatsApp
Inventory
Advanced analytics
```

## Business

₹3,999/month

```text
3 branches
50 users
Multi-branch
Advanced reports
Staff commissions
Retention automation
```

## Enterprise

₹7,999+/month

```text
5+ branches
HQ dashboard
Franchise
API
Advanced controls
Priority support
```

Pricing should be validated with real customers before launch.

---

# 46. Authentication

Recommended:

```text
Phone OTP
Email/password
Google login where useful
```

For staff:

```text
Phone/email
+
Password or OTP
+
Role
+
Tenant
+
Branch
```

JWT access token:

```text
user_id
tenant_id
roles
branch_scope
permissions_version
```

Use short-lived access tokens and refresh-token rotation.

---

# 47. Authorization

Use RBAC.

Example:

```text
customer.read
customer.create
customer.update
customer.delete

appointment.read
appointment.create
appointment.update
appointment.cancel

payment.read
payment.create
payment.refund

reports.read
reports.financial

inventory.read
inventory.adjust
inventory.transfer
```

Permissions should be granular.

---

# 48. API Structure

Base:

```text
/api/v1
```

Authentication:

```text
POST /auth/login
POST /auth/send-otp
POST /auth/verify-otp
POST /auth/refresh
POST /auth/logout
```

Tenant:

```text
GET /tenant
PATCH /tenant
```

Branches:

```text
GET /branches
POST /branches
GET /branches/:id
PATCH /branches/:id
DELETE /branches/:id
```

Customers:

```text
GET /customers
POST /customers
GET /customers/:id
PATCH /customers/:id
GET /customers/:id/timeline
GET /customers/:id/packages
GET /customers/:id/memberships
```

Services:

```text
GET /services
POST /services
PATCH /services/:id
```

Appointments:

```text
GET /appointments
POST /appointments
PATCH /appointments/:id
POST /appointments/:id/check-in
POST /appointments/:id/cancel
```

Queue:

```text
GET /queue
POST /queue
POST /queue/:id/call
POST /queue/:id/assign
POST /queue/:id/start
POST /queue/:id/complete
```

Sessions:

```text
POST /sessions
POST /sessions/:id/start
POST /sessions/:id/complete
```

Packages:

```text
GET /packages
POST /packages
POST /customer-packages
POST /customer-packages/:id/redeem
```

Billing:

```text
POST /invoices
GET /invoices
POST /invoices/:id/payment
POST /payments/webhook
```

Reports:

```text
GET /reports/revenue
GET /reports/customers
GET /reports/sessions
GET /reports/therapists
GET /reports/branches
```

---

# 49. API Security

Every API request should pass:

```text
Request
 ↓
Rate Limit
 ↓
Authentication
 ↓
Tenant Context
 ↓
Permission Check
 ↓
Validation
 ↓
Business Logic
 ↓
Database
```

Use:

- HTTPS
- JWT/secure sessions
- Rate limiting
- Input validation
- SQL parameterization/ORM
- Audit logging
- Secure headers
- CSRF protection where applicable
- Webhook signature verification
- Secrets management

---

# 50. Audit Logs

Create:

```text
audit_logs
---------
id
tenant_id
user_id
action
entity_type
entity_id
old_values
new_values
ip_address
user_agent
created_at
```

Examples:

```text
USER_CREATED
CUSTOMER_UPDATED
INVOICE_VOIDED
PAYMENT_REFUNDED
PACKAGE_CREATED
STOCK_ADJUSTED
ROLE_CHANGED
```

Financial and permission changes should always be auditable.

---

# 51. Event Architecture

Use internal domain events.

Example:

```text
Appointment Created
        │
        ├── Notification
        ├── Analytics
        └── Audit Log
```

Another:

```text
Session Completed
        │
        ├── Update package usage
        ├── Update customer visit history
        ├── Calculate therapist commission
        ├── Update analytics
        ├── Request feedback
        └── Trigger retention logic
```

This prevents business logic from becoming tightly coupled.

---

# 52. Background Jobs

Examples:

```text
appointment-reminder
package-expiry-reminder
membership-renewal
birthday-campaign
inactive-customer-detection
daily-report
weekly-business-report
low-stock-alert
invoice-generation
whatsapp-message
email-message
```

Job architecture:

```text
API
 ↓
Create Job
 ↓
Redis Queue
 ↓
Worker
 ↓
Execute
 ↓
Retry if required
 ↓
Dead Letter / Failed Job
```

Use retries with exponential backoff.

---

# 53. Search

V1:

PostgreSQL indexes.

Search:

```text
Customer name
Phone
Email
Customer code
Invoice number
Appointment
Product SKU
```

Later:

Elasticsearch / OpenSearch if search volume requires it.

---

# 54. Reporting Strategy

Reports should support:

```text
Today
Yesterday
This Week
This Month
Last Month
Custom Date Range
```

Filters:

```text
Branch
Service
Therapist
Payment method
Customer type
Package
Membership
```

Export:

```text
CSV
Excel
PDF
```

---

# 55. Notification Preferences

Each tenant should configure:

```text
Appointment reminders
Payment messages
Package expiry
Membership expiry
Marketing
Feedback
Birthday
```

Customer-level opt-in/opt-out must be respected.

Marketing communication should require appropriate consent and comply with applicable messaging rules.

---

# 56. Business Onboarding

First login:

```text
Create Business
       ↓
Business Information
       ↓
Choose Business Type
       ↓
Create First Branch
       ↓
Add Services
       ↓
Add Staff
       ↓
Configure Taxes
       ↓
Configure Payments
       ↓
WhatsApp Setup
       ↓
Complete
```

Business types:

```text
Ayurveda
Massage
Wellness
Physiotherapy
Foot Therapy
Alternative Therapy
Other
```

The business type should mainly configure defaults; it should not lock the tenant into one workflow.

---

# 57. Onboarding Wizard

### Step 1

Business name

### Step 2

Logo

### Step 3

Address

### Step 4

Branch

### Step 5

Services

### Step 6

Prices

### Step 7

Therapists

### Step 8

Payment setup

### Step 9

WhatsApp

### Step 10

Go Live

---

# 58. Customer Journey

```text
Customer discovers business
        ↓
Calls / WhatsApp / Website
        ↓
Appointment or Walk-in
        ↓
Customer Registration
        ↓
Check-in
        ↓
Queue
        ↓
Therapist Assignment
        ↓
Therapy Session
        ↓
Payment / Package Redemption
        ↓
Feedback
        ↓
Follow-up
        ↓
Repeat Visit
        ↓
Membership / Package
```

---

# 59. Business Journey

```text
Lead
 ↓
Customer
 ↓
First Visit
 ↓
Second Visit
 ↓
Package
 ↓
Membership
 ↓
Repeat Customer
 ↓
VIP / Loyal
```

Analytics should track each transition.

---

# 60. Revenue Model for Rkyves

Revenue streams:

```text
1. SaaS subscription
2. Annual plans
3. WhatsApp messaging margin/add-on
4. Payment integrations where commercially applicable
5. Premium analytics
6. Additional branch fees
7. Additional user fees
8. White-label
9. Enterprise onboarding
10. Custom integrations
```

Avoid making transaction commissions the only monetization model.

---

# 61. White Label

Future enterprise feature:

```text
Tenant Branding

Logo
Primary color
Domain
Email sender
WhatsApp identity
Invoice branding
Customer app branding
```

Example:

```text
app.customerbrand.com
```

Powered by Rkyves.

---

# 62. Notifications Architecture

```text
Business Event
      ↓
Notification Service
      ↓
Preference Check
      ↓
Template Resolver
      ↓
Channel Router
      │
 ┌────┼─────┐
 │    │     │
SMS Email WhatsApp
 │    │     │
 └────┼─────┘
      ↓
Delivery Status
      ↓
Notification Log
```

---

# 63. Notification Templates

Templates should be tenant configurable.

Example:

```text
Appointment Confirmation

Hi {{customer_name}},

Your appointment at {{branch_name}}
is confirmed for {{appointment_time}}.

Service:
{{service_name}}
```

Store templates:

```text
notification_templates
```

---

# 64. Data Privacy

Customer data is sensitive.

Implement:

- Least-privilege access
- Encryption in transit
- Encryption at rest
- Audit logs
- Data retention policies
- Access controls
- Export/delete workflows where legally required
- Secure backups
- Secret management

Do not collect unnecessary medical information.

If the product later stores health/medical records, conduct a separate privacy/compliance design before implementing that functionality.

---

# 65. Backup Strategy

Database:

```text
Daily full backup
+
Point-in-time recovery
```

Object storage:

```text
Versioning
+
Lifecycle policies
```

Backups should be encrypted.

Test restoration regularly.

---

# 66. Disaster Recovery

Define:

```text
RPO
Recovery Point Objective

RTO
Recovery Time Objective
```

Suggested early target:

```text
RPO: < 1 hour
RTO: < 4 hours
```

Exact targets should be adjusted according to plan and infrastructure budget.

---

# 67. Observability

Use:

```text
Application logs
Metrics
Tracing
Error monitoring
Uptime monitoring
```

Track:

```text
API latency
Error rate
DB connections
CPU
Memory
Queue depth
Worker failures
WhatsApp failures
Payment webhook failures
```

Integrate with existing Rkyves monitoring practices where possible.

---

# 68. Deployment Architecture

Initial production:

```text
Internet
   ↓
Cloudflare
   ↓
Load Balancer
   ↓
Application VM / Container
   ↓
PostgreSQL
   ↓
Redis
   ↓
Worker
```

For higher scale:

```text
Cloudflare
    ↓
Load Balancer
    ↓
Kubernetes
    ├── API pods
    ├── Worker pods
    └── Web pods
          │
          ├── PostgreSQL
          ├── Redis
          └── Object Storage
```

Do not introduce Kubernetes solely for architectural fashion. Use it when traffic, availability or operational requirements justify it.

---

# 69. CI/CD

Recommended:

```text
GitHub
   ↓
Pull Request
   ↓
Automated Tests
   ↓
Lint
   ↓
Build
   ↓
Security Scan
   ↓
Deploy Staging
   ↓
QA
   ↓
Production Approval
   ↓
Deploy
```

Environments:

```text
development
staging
production
```

Never develop directly on production.

---

# 70. Database Migration Strategy

Use migrations.

Example:

```text
001_create_tenants
002_create_users
003_create_branches
004_create_customers
005_create_services
006_create_appointments
007_create_sessions
008_create_packages
009_create_memberships
010_create_invoices
...
```

Never manually modify production schema without migration tracking.

---

# 71. Testing Strategy

## Unit Tests

Test:

- Pricing
- Discounts
- Package redemption
- Membership expiry
- Commission
- Tax
- Permissions

## Integration Tests

Test:

```text
Appointment → Session
Session → Package redemption
Session → Payment
Payment → Invoice
Inventory → Sale
```

## E2E

Test:

```text
Customer registration
Appointment
Check-in
Therapy
Payment
Receipt
Feedback
```

---

# 72. Critical Business Rules

## Package Redemption

```text
IF package active
AND not expired
AND remaining quantity > 0
THEN
redeem session
ELSE
reject
```

## Membership

```text
IF membership active
THEN
apply configured benefits
ELSE
regular pricing
```

## Payment

Invoice should not become `PAID` until payment is confirmed.

## Refund

Refund must create an auditable financial event.

## Tenant Security

Every tenant-owned database query must enforce tenant isolation.

---

# 73. Database Indexes

Important indexes:

```text
customers:
tenant_id + phone
tenant_id + name

appointments:
tenant_id + branch_id + appointment_date
tenant_id + therapist_id + appointment_date

sessions:
tenant_id + customer_id
tenant_id + therapist_id
tenant_id + created_at

payments:
tenant_id + created_at
tenant_id + invoice_id

inventory:
tenant_id + branch_id + product_id
```

Add indexes based on actual query patterns and query plans.

---

# 74. Frontend Application Structure

```text
web/
│
├── app/
│   ├── login
│   ├── onboarding
│   ├── dashboard
│   ├── customers
│   ├── appointments
│   ├── queue
│   ├── sessions
│   ├── therapists
│   ├── services
│   ├── packages
│   ├── memberships
│   ├── pos
│   ├── invoices
│   ├── payments
│   ├── inventory
│   ├── expenses
│   ├── reports
│   ├── analytics
│   ├── marketing
│   ├── branches
│   ├── staff
│   └── settings
│
├── components/
├── hooks/
├── services/
├── stores/
├── types/
└── utils/
```

---

# 75. Navigation

## Owner

```text
Dashboard
Customers
Appointments
Queue
Sessions
Services
Packages
Memberships
POS
Inventory
Expenses
Marketing
Reports
Analytics
Branches
Staff
Settings
```

## Receptionist

```text
Dashboard
Customers
Appointments
Queue
POS
Payments
```

## Therapist

```text
Today
My Sessions
Customers
Profile
```

## Accountant

```text
Dashboard
Invoices
Payments
Expenses
Reports
```

---

# 76. Customer App — Future

```text
Home
│
├── Nearby Centers
├── Book
├── Appointments
├── Membership
├── Packages
├── Rewards
├── Offers
├── Payments
└── Profile
```

Do not make this a V1 dependency.

---

# 77. QR Features

Potential uses:

### Branch QR

Scan to:

- Open branch profile
- Book appointment

### Table/room QR

Future:

- Identify therapy room
- Start session

### Feedback QR

After session:

```text
Scan
 ↓
Rate
 ↓
Feedback
```

---

# 78. Marketing Automation

Future module:

```text
Customer Segment
       ↓
Campaign
       ↓
Offer
       ↓
WhatsApp/SMS
       ↓
Conversion
       ↓
Revenue Attribution
```

Campaign examples:

```text
Inactive customers
Birthday customers
Package expiring
Membership expiring
First-time visitors
High-value customers
```

---

# 79. Business Intelligence

The analytics layer should eventually answer:

### Revenue

"What generated revenue?"

### Customers

"Who is spending?"

### Retention

"Who is leaving?"

### Operations

"Where are bottlenecks?"

### Staff

"How efficiently is staff being used?"

### Products

"Which products are profitable?"

### Branches

"Which branches need operational attention?"

---

# 80. AI Features — Future

Do not make AI a V1 dependency.

Future capabilities:

### AI Business Assistant

Owner asks:

> Why did revenue fall this week?

System analyzes:

```text
Revenue
Sessions
New customers
Returning customers
Appointments
Cancellations
Branch performance
```

and generates an explanation with supporting metrics.

Other examples:

> Which customers should we contact this week?

> Which services are growing?

> Which branches have declining repeat visits?

> What time slots have the highest demand?

AI should summarize actual business data, not invent conclusions.

---

# 81. Rkyves Shared Platform Opportunity

TherapyOS should eventually share infrastructure with other Rkyves products.

```text
                 RKYVES PLATFORM
                        │
        ┌───────────────┼────────────────┐
        │               │                │
     Cullinos       TherapyOS        Jerzyfy
        │               │                │
        └───────────────┼────────────────┘
                        │
              Shared Platform Services
                        │
        ┌───────────────┼─────────────────┐
        │               │                 │
      Auth           Billing         Notifications
        │               │                 │
     Tenancy        Payments          WhatsApp
        │               │                 │
     Analytics       Audit             Storage
```

This can reduce engineering duplication.

---

# 82. V1 Development Roadmap

## Phase 1 — Foundation

```text
Authentication
Tenant
Users
Roles
Branches
Database
API
Audit
```

## Phase 2 — Core Operations

```text
Customers
Services
Therapists
Appointments
Queue
Sessions
```

## Phase 3 — Money

```text
POS
Invoices
Payments
Packages
Memberships
```

## Phase 4 — Management

```text
Inventory
Expenses
Reports
Analytics
```

## Phase 5 — Retention

```text
Notifications
WhatsApp
Feedback
Customer segmentation
Win-back
```

## Phase 6 — Scale

```text
Multi-branch
HQ
Franchise
Advanced analytics
Customer app
API
White-label
```

---

# 83. V1 Minimum Feature Set

The first sellable version should contain:

```text
✓ Login
✓ Business onboarding
✓ Branch
✓ Staff
✓ Roles
✓ Customer CRM
✓ Services
✓ Therapist management
✓ Appointments
✓ Walk-ins
✓ Queue
✓ Session tracking
✓ Packages
✓ POS
✓ Invoice
✓ Payments
✓ Basic reports
```

Avoid building:

```text
✗ Full medical records
✗ Complex AI
✗ Consumer social network
✗ Loyalty ecosystem
✗ Franchise royalty engine
✗ Advanced BI warehouse
✗ Microservices
```

until customer demand validates them.

---

# 84. First Pilot Customer Strategy

Use a real therapy/wellness center as the design partner.

The pilot should map:

```text
Current process
      ↓
Pain points
      ↓
TherapyOS workflow
      ↓
Measure improvement
```

Measure:

- Reception time
- Customer wait time
- Billing time
- Repeat visits
- Package sales
- No-shows
- Staff utilization
- Revenue visibility

The product should be shaped by actual operating workflows rather than only by assumptions from a website.

---

# 85. Recommended MVP Architecture

```text
                  CLOUDFLARE
                      │
                      ▼
               NEXT.JS WEB APP
                      │
                      ▼
                NESTJS API
                      │
          ┌───────────┼────────────┐
          │           │            │
          ▼           ▼            ▼
      PostgreSQL     Redis       Worker
          │           │            │
          │           │       ┌────┼────┐
          │           │       │    │    │
          │           │    WhatsApp Email Jobs
          │
          ▼
      Object Storage
```

---

# 86. Recommended Repository

Use a monorepo if practical.

```text
therapyos/
│
├── apps/
│   ├── web/
│   ├── api/
│   └── mobile/
│
├── packages/
│   ├── ui/
│   ├── types/
│   ├── config/
│   ├── validation/
│   └── api-client/
│
├── infrastructure/
│   ├── docker/
│   ├── terraform/
│   └── k8s/
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── database/
│   └── product/
│
└── README.md
```

---

# 87. Recommended API Coding Pattern

Use:

```text
Controller
    ↓
DTO / Validation
    ↓
Guard / Permission
    ↓
Service
    ↓
Repository
    ↓
Database
```

Example:

```text
POST /appointments
        ↓
AppointmentController
        ↓
CreateAppointmentDto
        ↓
AuthGuard
        ↓
PermissionGuard
        ↓
AppointmentService
        ↓
AppointmentRepository
        ↓
PostgreSQL
```

Business logic must not live in controllers.

---

# 88. Error Handling

Standard API response:

```json
{
  "success": false,
  "error": {
    "code": "PACKAGE_EXPIRED",
    "message": "Customer package has expired."
  },
  "requestId": "req_123"
}
```

Success:

```json
{
  "success": true,
  "data": {},
  "requestId": "req_123"
}
```

Use consistent error codes.

---

# 89. API Versioning

Start with:

```text
/api/v1
```

Do not break existing clients.

Future:

```text
/api/v2
```

---

# 90. Feature Flags

Create feature flags:

```text
feature_flags
---------
id
tenant_id
key
enabled
config
```

Examples:

```text
WHATSAPP_ENABLED
MEMBERSHIP_ENABLED
INVENTORY_ENABLED
ADVANCED_ANALYTICS
CUSTOMER_APP
FRANCHISE
AI_ASSISTANT
```

This allows controlled rollout.

---

# 91. Tenant Configuration

```text
tenant_settings
---------
tenant_id
setting_key
setting_value
```

Examples:

```text
CURRENCY
TIMEZONE
TAX_MODE
INVOICE_PREFIX
APPOINTMENT_BUFFER
DEFAULT_APPOINTMENT_DURATION
WHATSAPP_ENABLED
```

---

# 92. Localization

Design for:

```text
India first
INR
IST
Indian phone numbers
GST
UPI
Razorpay
WhatsApp
```

But keep architecture extensible for:

```text
USD
AED
GBP
Other currencies
```

Do not hard-code India-specific assumptions into the domain model where avoidable.

---

# 93. Tax Architecture

Do not hardcode a single tax rate.

```text
tax_rates
---------
id
tenant_id
name
rate
type
effective_from
effective_to
status
```

Invoice should preserve the applied tax amount/rate at transaction time.

This protects historical invoices if rates change later.

---

# 94. Financial Ledger Direction

For V1, invoice/payment tables are enough.

As the platform grows, introduce:

```text
ledger_entries
```

for proper accounting/reporting.

Potential structure:

```text
Account
  ↓
Debit
Credit
Reference
Date
Tenant
Branch
```

This should be Phase 2/3 after validating actual accounting requirements.

---

# 95. Security Checklist

Before production:

```text
[ ] HTTPS
[ ] Secrets manager
[ ] Database encryption
[ ] Tenant isolation tests
[ ] RBAC tests
[ ] Rate limiting
[ ] Input validation
[ ] SQL injection protection
[ ] XSS protection
[ ] Secure cookies/tokens
[ ] Webhook verification
[ ] Audit logging
[ ] Backup
[ ] Restore test
[ ] Dependency scanning
[ ] Container scanning
[ ] Production access control
```

---

# 96. Performance Targets

Initial targets:

```text
API p95 < 500 ms
Normal page load < 2.5 sec
Database queries < 200 ms for common operations
Background jobs asynchronous
```

Targets should be monitored rather than treated as guarantees.

---

# 97. Scalability Path

### Stage 1

```text
1–50 tenants
Single API deployment
Single PostgreSQL
Redis
Worker
```

### Stage 2

```text
50–500 tenants
Multiple API instances
Read replicas if needed
Dedicated workers
CDN
```

### Stage 3

```text
500+ tenants
Horizontal scaling
Analytics database
Dedicated integration services
Queue scaling
Potential service extraction
```

Do not prematurely optimize for millions of tenants.

---

# 98. Operational Alerts

Owner alerts:

```text
Low inventory
Unpaid invoices
Expiring packages
Expiring memberships
High cancellation rate
No-show increase
Revenue anomaly
Branch issue
```

Platform alerts:

```text
API errors
Database errors
Worker failures
Payment webhook failures
WhatsApp failures
Storage errors
```

---

# 99. Product Success Metrics

Track TherapyOS itself:

## SaaS

```text
MRR
ARR
Active tenants
New tenants
Churn
Trial → Paid conversion
ARPU
Expansion revenue
```

## Customer usage

```text
Weekly active businesses
Monthly active businesses
Sessions processed
Invoices generated
Appointments created
Packages sold
Messages sent
```

---

# 100. Final Product Structure

```text
                         RKYVES
                           │
                      THERAPYOS
                           │
       ┌───────────────────┼────────────────────┐
       │                   │                    │
    OPERATIONS          REVENUE             GROWTH
       │                   │                    │
       ├─ Customers        ├─ POS              ├─ WhatsApp
       ├─ Appointments     ├─ Billing          ├─ Campaigns
       ├─ Queue            ├─ Payments         ├─ Retention
       ├─ Sessions         ├─ Packages         ├─ Offers
       ├─ Therapists       └─ Memberships      └─ Feedback
       │
       ├─ Services
       ├─ Branches
       └─ Inventory

                           │
                       MANAGEMENT
                           │
             ┌─────────────┼─────────────┐
             │             │             │
          Reports       Analytics      Franchise
             │             │             │
             └─────────────┼─────────────┘
                           │
                      PLATFORM LAYER
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
      Auth              Billing            Notifications
       │                   │                   │
    Tenancy             Payments            WhatsApp
    RBAC                Subscriptions       Email/SMS
    Audit               Invoices            Push
```

---

# 101. Recommended Build Order

The engineering team should implement in this exact broad order:

```text
1. Repository + CI/CD
2. Database + migrations
3. Authentication
4. Tenant system
5. RBAC
6. Business onboarding
7. Branches
8. Staff
9. Services
10. Customers
11. Therapists
12. Appointments
13. Walk-in queue
14. Therapy sessions
15. Packages
16. POS
17. Invoices
18. Payments
19. Basic reports
20. Inventory
21. Expenses
22. Notifications
23. WhatsApp
24. Customer retention
25. Advanced analytics
26. Multi-branch HQ
27. Franchise
28. Customer mobile app
29. AI assistant
30. White-label
```

---

# 102. Engineering Principle

The most important architectural principle:

> **Build the core around business entities and events, not around screens.**

For example:

```text
Customer
Appointment
Session
Invoice
Payment
Package
Membership
Therapist
Branch
Product
```

These entities should have clean APIs and domain rules.

The UI should consume those capabilities.

This makes TherapyOS easier to extend into:

- Mobile apps
- Franchise systems
- APIs
- White-label deployments
- AI analytics
- External integrations

---

# 103. Final Recommendation

For Rkyves, TherapyOS should be treated as a **second vertical SaaS product alongside Cullinos**.

The strategic architecture should be:

```text
Rkyves Platform
│
├── Shared Authentication
├── Shared Tenant Infrastructure
├── Shared Billing
├── Shared Notifications
├── Shared WhatsApp Integration
├── Shared Analytics Foundation
├── Shared Audit
│
├── Cullinos
│   └── Restaurant / Food Business
│
├── TherapyOS
│   └── Therapy / Wellness Business
│
└── Future Vertical SaaS
    ├── SalonOS
    ├── GymOS
    ├── ClinicOS
    └── Other verticals
```

The long-term opportunity is not simply to create another appointment application.

It is to create a **reusable Rkyves vertical-SaaS platform** where common infrastructure is shared while each industry gets its own specialized operating system.
