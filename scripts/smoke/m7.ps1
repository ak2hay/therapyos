$ErrorActionPreference = 'Stop'
$root = 'http://localhost:4000'
$base = "$root/api/v1"

function Call($method, $path, $token, $body, $apiKey) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  if ($apiKey) { $headers['x-api-key'] = $apiKey }
  $params = @{ Uri = "$base$path"; Method = $method; Headers = $headers; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $body) { $params.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 10)) }
  try { (Invoke-RestMethod @params).data }
  catch {
    $msg = $_.ErrorDetails.Message
    throw "$method $path failed: $msg"
  }
}

function Page($path, $token) {
  $r = Invoke-RestMethod -Uri "$base$path" -Headers @{ Authorization = "Bearer $token" }
  [pscustomobject]@{ items = @($r.data); meta = $r.meta }
}

function Expect-Fail($method, $path, $token, $body, $status, $apiKey) {
  try { Call $method $path $token $body $apiKey | Out-Null; throw "Expected $status for $method $path but it succeeded" }
  catch { if ("$_" -notmatch "$status|$($status -replace '_', ' ')") { throw "Expected $status for $method $path, got: $_" } }
}

function Assert($cond, $msg) { if (-not $cond) { throw "ASSERT FAILED: $msg" } }
# Logins are throttled (5/min per IP); wait out the window instead of failing.
function Login($id, $password = 'Demo@12345') {
  for ($i = 0; $i -lt 6; $i++) {
    try { return (Call POST '/auth/login' $null @{ identifier = $id; password = $password }).tokens.accessToken }
    catch { if ("$_" -match 'TOO_MANY|Too Many|429') { Start-Sleep -Seconds 15 } else { throw } }
  }
  throw "Login throttled for $id"
}
function AdminLogin() {
  for ($i = 0; $i -lt 6; $i++) {
    try { return (Call POST '/auth/admin/login' $null @{ email = 'admin@rkyves.com'; password = 'Admin@12345' }).tokens.accessToken }
    catch { if ("$_" -match 'TOO_MANY|Too Many|429') { Start-Sleep -Seconds 15 } else { throw } }
  }
}

$o = Login 'owner@serenity.demo'
$m = Login 'manager@serenity.demo'
$rc = Login 'reception@serenity.demo'
$admin = AdminLogin
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$kor = $branches | Where-Object code -eq 'KOR'

# 1. HQ dashboard: every branch for the owner, scoped for a branch manager, hidden from reception
$from = (Get-Date).AddDays(-29).ToString('yyyy-MM-dd'); $to = (Get-Date).ToString('yyyy-MM-dd')
$hq = Call GET "/hq/overview?from=$from&to=$to" $o $null
Assert ($hq.branches.Count -ge 2 -and $hq.totals.revenue -gt 0) "HQ covers all branches (revenue $($hq.totals.revenue))"
$sumRev = [math]::Round((($hq.branches | Measure-Object revenue -Sum).Sum), 2)
Assert ([math]::Abs($sumRev - $hq.totals.revenue) -lt 1) "branch revenue adds up to totals ($sumRev vs $($hq.totals.revenue))"
Assert ($hq.trend.Count -ge 28) 'daily trend'
Assert (($hq.branches | Where-Object code -eq 'KOR').franchisee.name -match 'Koramangala') 'franchised branch labelled'
$area = Login 'area@serenity.demo'
$hqa = Call GET "/hq/overview?from=$from&to=$to" $area $null
Assert ($hqa.branches.Count -eq 1 -and $hqa.branches[0].code -eq 'KOR') 'area manager sees only assigned branches'
Assert ([math]::Abs($hqa.totals.revenue - ($hq.branches | Where-Object code -eq 'KOR').revenue) -lt 1) 'area totals match their branch'
Expect-Fail GET "/hq/overview?from=$from&to=$to" $m $null 'FORBIDDEN'
"HQ: $($hq.branches.Count) branches, revenue=$($hq.totals.revenue) growth=$($hq.totals.revenueGrowth)% profit=$($hq.totals.profit); area manager sees $($hqa.branches[0].name)"

# 2. Franchise: overview, fees, idempotent royalty run, branch ownership conflicts
$fo = Call GET '/franchise/overview' $o $null
Assert ($fo.franchisees -ge 1 -and $fo.branches -ge 1) 'franchise overview'
$fees = Page '/franchise/fees?pageSize=50' $o
Assert ($fees.meta.summary.paid -gt 250000) "joining fee and royalties paid ($($fees.meta.summary.paid))"
$run = Call POST '/franchise/royalties/run' $o @{ month = $fo.lastClosedMonth }
Assert ($run.contracts -ge 1 -and $run.created -eq 0) "re-running $($fo.lastClosedMonth) creates no duplicates (created=$($run.created))"
$line = $run.lines[0]
Assert ([math]::Abs($line.royalty - [math]::Round($line.grossRevenue * 0.06, 2)) -lt 0.02) "royalty = 6% of net sales ($($line.royalty) of $($line.grossRevenue))"
Expect-Fail POST '/franchise/royalties/run' $o @{ month = (Get-Date).AddMonths(2).ToString('yyyy-MM') } 'VALIDATION'
$fr = (Call GET '/franchise/franchisees' $o $null) | Select-Object -First 1
$other = Call POST '/franchise/franchisees' $o @{ franchiseGroupId = $fr.franchiseGroupId; name = "Smoke Franchisee $(Get-Random)"; ownerName = 'Smoke Owner'; phone = '+919800011122'; branchIds = @() }
Expect-Fail PATCH "/franchise/franchisees/$($other.id)" $o @{ branchIds = @($kor.id) } 'CONFLICT'
Call PATCH "/franchise/franchisees/$($other.id)" $o @{ status = 'INACTIVE' } | Out-Null
Expect-Fail GET '/franchise/overview' $rc $null 'FORBIDDEN'
"Franchise: $($fo.franchisees) franchisees, outstanding=$($fo.outstanding), royalty $($fo.lastClosedMonth) = $($line.royalty) on $($line.grossRevenue); $($fr.name)"

# 3. Public API keys: scoped access, docs, revoke
$keys = Call GET '/api-keys' $o $null
Assert ($keys.scopes.Count -ge 5 -and $keys.docsUrl -match '/api/docs') 'scopes and docs link'
$key = Call POST '/api-keys' $o @{ name = 'Smoke website'; scopes = @('service.read', 'branch.read') }
Assert ($key.key -match '^tos_' -and -not $key.keyHash) 'raw key shown once, hash hidden'
$svcByKey = Call GET '/services' $null $null $key.key
Assert (@($svcByKey).Count -gt 5) 'API key lists services'
Expect-Fail GET '/customers' $null $null 'FORBIDDEN' $key.key
Expect-Fail GET '/invoices' $null $null 'UNAUTHENTICATED|FORBIDDEN' $key.key
Expect-Fail POST '/api-keys' $o @{ name = 'Bad'; scopes = @('invoice.refund') } 'VALIDATION'
Expect-Fail GET '/api-keys' $m $null 'FORBIDDEN'
Call DELETE "/api-keys/$($key.id)" $o $null | Out-Null
Expect-Fail GET '/services' $null $null 'UNAUTHENTICATED' $key.key
$docs = Invoke-WebRequest -Uri "$root/api/docs-json" -UseBasicParsing
Assert ($docs.Content -match '"/api/v1/public/booking/\{slug\}"') 'OpenAPI documents public booking'
"API keys: scoped key read services, blocked elsewhere, revoked"

# 4. White label: branding, custom domain resolution
$before = Call GET '/branding' $o $null
$saved = Call PUT '/branding' $o @{ appName = 'Serenity Spa & Wellness'; primaryColor = '#7c3aed'; customDomain = 'book.serenity-smoke.test'; invoiceFooter = $before.invoiceFooter; poweredBy = $false }
Assert ($saved.customDomain -eq 'book.serenity-smoke.test') 'custom domain saved'
$pb = Call GET '/public/branding?domain=book.serenity-smoke.test' $null $null
Assert ($pb.slug -eq 'serenity-wellness' -and $pb.primaryColor -eq '#7c3aed' -and -not $pb.poweredBy) 'domain resolves to tenant branding'
Expect-Fail GET '/public/branding?domain=nobody.example.com' $null $null 'NOT_FOUND'
Expect-Fail PUT '/branding' $m @{ appName = 'x' } 'FORBIDDEN'
Call PUT '/branding' $o @{ appName = $before.appName; primaryColor = $before.primaryColor; accentColor = $before.accentColor; logoUrl = $before.logoUrl; invoiceFooter = $before.invoiceFooter; poweredBy = $true } | Out-Null
Expect-Fail GET '/public/branding?domain=book.serenity-smoke.test' $null $null 'NOT_FOUND'
"White label: custom domain resolved then disconnected"

# 5. Public booking page + branch QR
$bk = Call GET '/public/booking/serenity-wellness' $null $null
Assert ($bk.branches.Count -ge 1 -and $bk.services.Count -gt 5) "booking info: $($bk.branches.Count) branches, $($bk.services.Count) services"
$svc = $bk.services | Where-Object { $_.branches | Where-Object branchId -eq $ind.id } | Select-Object -First 1
$day = (Get-Date).AddDays(2).ToString('yyyy-MM-dd')
$slots = Call GET "/public/booking/serenity-wellness/slots?branchId=$($ind.id)&serviceId=$($svc.id)&date=$day" $null $null
Assert ($slots.slots.Count -gt 0 -and $slots.therapists.Count -gt 0) "open slots on $day"
$slot = $slots.slots | Select-Object -Last 1
$phone = "+9197$('{0:D8}' -f (Get-Random -Maximum 99999999))"
$booked = Call POST '/public/booking/serenity-wellness' $null @{ branchId = $ind.id; serviceId = $svc.id; date = $day; startTime = $slot.time; therapistId = $slot.therapistIds[0]; name = 'Smoke Online Guest'; phone = $phone; notes = 'First visit' }
Assert ($booked.appointmentId -and $booked.service -eq $svc.name) 'online booking confirmed'
$appt = Call GET "/appointments/$($booked.appointmentId)" $o $null
Assert ($appt.source -eq 'WEBSITE' -and $appt.customer.phone -eq $phone) 'appointment stored with WEBSITE source and new customer'
Expect-Fail POST '/public/booking/serenity-wellness' $null @{ branchId = $ind.id; serviceId = $svc.id; date = $day; startTime = $slot.time; therapistId = $slot.therapistIds[0]; name = 'Smoke Clash'; phone = '+919700000001' } 'SLOT_UNAVAILABLE'
Expect-Fail GET "/public/booking/serenity-wellness/slots?branchId=$($ind.id)&serviceId=$($svc.id)&date=$((Get-Date).AddDays(90).ToString('yyyy-MM-dd'))" $null $null 'VALIDATION'
Expect-Fail GET '/public/booking/serene-skin' $null $null 'NOT_FOUND'
$qr = Call GET "/booking/qr/$($ind.id)" $m $null
Assert ($qr.png -match '^data:image/png;base64,' -and $qr.url -match '/book/serenity-wellness\?branch=ind$' -and $qr.enabled) "booking QR for $($qr.url)"
"Public booking: $($booked.service) with $($booked.therapist) on $day $($booked.startTime)"

# 6. Subscription billing + plan limits (Mindful Care, Starter plan)
$mc = Login 'owner@mindfulcare.demo'
$sub = Call GET '/subscription' $mc $null
Assert ($sub.subscription.plan.code -eq 'STARTER' -and $sub.plans.Count -ge 3) "mindful-care on $($sub.subscription.plan.code)"
Expect-Fail POST '/branches' $mc @{ name = 'Second Branch'; code = 'SEC'; city = 'Pune' } 'PLAN_LIMIT_REACHED'
Expect-Fail GET '/api-keys' $mc $null 'FEATURE_DISABLED'
$growth = $sub.plans | Where-Object code -eq 'GROWTH'
$changed = Call POST '/subscription/change' $mc @{ planId = $growth.id; billingCycle = 'MONTHLY' }
Assert ($changed.status -eq 'ACTIVE') 'mock provider activates the new plan immediately'
$sub2 = Call GET '/subscription' $mc $null
Assert ($sub2.subscription.plan.code -eq 'GROWTH' -and $sub2.limits.users -eq 15 -and $sub2.invoices[0].status -eq 'PAID') "upgraded to GROWTH (staff limit $($sub2.limits.users))"
Assert ((Call GET '/auth/me' $mc $null).features -contains 'INVENTORY_ENABLED') 'plan features unlocked immediately'
Call POST '/subscription/cancel' $mc $null | Out-Null
Assert ((Call GET '/subscription' $mc $null).subscription.cancelledAt) 'cancel at period end'
Call POST '/subscription/resume' $mc $null | Out-Null
Assert (-not (Call GET '/subscription' $mc $null).subscription.cancelledAt) 'resumed'
$starter = $sub.plans | Where-Object code -eq 'STARTER'
Call POST '/subscription/change' $mc @{ planId = $starter.id; billingCycle = 'MONTHLY' } | Out-Null
Expect-Fail GET '/subscription' $m $null 'FORBIDDEN'
"Subscription: STARTER -> GROWTH (paid invoice) -> cancel/resume -> STARTER"

# 7. Support tickets: tenant <-> platform
$t = Call POST '/support/tickets' $o @{ subject = "Smoke: invoice PDF logo $(Get-Random)"; description = 'The logo on invoice PDFs is blurry.'; priority = 'MEDIUM' }
$inbox = Page "/admin/support?status=OPEN,IN_PROGRESS&pageSize=100" $admin
$row = $inbox.items | Where-Object id -eq $t.id
Assert ($row -and $row.tenant.slug -eq 'serenity-wellness') 'ticket in the platform inbox with its tenant'
Call POST "/admin/support/$($t.id)/messages" $admin @{ body = 'Thanks! Upload a 512px PNG in Settings > Branding and it will be sharp.' } | Out-Null
$tv = Call GET "/support/tickets/$($t.id)" $o $null
Assert ($tv.status -eq 'WAITING_ON_CUSTOMER' -and $tv.messages[-1].authorType -eq 'ADMIN') 'reply visible to the business'
$bell = Call GET '/notifications/in-app' $o $null
Assert ($bell.items | Where-Object { $_.type -eq 'SUPPORT_REPLY' -and $_.link -match $t.id }) 'ticket creator notified'
Call POST "/support/tickets/$($t.id)/messages" $o @{ body = 'That worked, thank you.' } | Out-Null
Assert ((Call GET "/support/tickets/$($t.id)" $o $null).status -eq 'OPEN') 'customer reply reopens'
Call PATCH "/admin/support/$($t.id)" $admin @{ status = 'RESOLVED' } | Out-Null
Expect-Fail GET "/admin/support" $o $null 'FORBIDDEN'
Expect-Fail GET '/branches' $admin $null 'FORBIDDEN'
"Support: ticket answered, customer notified, resolved"

# 8. Super admin console: metrics, tenants, flags, plans, system health
$met = Call GET '/admin/metrics' $admin $null
Assert ($met.mrr -gt 0 -and [math]::Abs($met.arr - $met.mrr * 12) -lt 1 -and $met.tenants.total -ge 7) "MRR=$($met.mrr) ARR=$($met.arr) tenants=$($met.tenants.total)"
Assert ($met.trend.Count -eq 6 -and $met.plans.Count -ge 3) 'trend + plan breakdown'
$list = Page '/admin/tenants?subscriptionStatus=PAST_DUE' $admin
Assert ($list.items | Where-Object slug -eq 'fitfix-rehab') 'filter by subscription status'
$mcId = ((Page '/admin/tenants?search=mindful' $admin).items | Select-Object -First 1).id
$detail = Call GET "/admin/tenants/$mcId" $admin $null
Assert ($detail.subscription.plan.code -eq 'STARTER' -and $detail.subscriptionHistory.Count -ge 3 -and $detail.owners.Count -ge 1) 'tenant detail with subscription history'

Call PUT '/admin/flags' $admin @{ key = 'FRANCHISE'; tenantId = $mcId; enabled = $true } | Out-Null
Assert ((Call GET '/auth/me' $mc $null).features -contains 'FRANCHISE') 'per-tenant override enables a feature'
Call PUT '/admin/flags' $admin @{ key = 'FRANCHISE'; tenantId = $mcId; enabled = $null } | Out-Null
Assert (-not ((Call GET '/auth/me' $mc $null).features -contains 'FRANCHISE')) 'override removed'
Call PUT '/admin/flags' $admin @{ key = 'AI_ASSISTANT'; enabled = $false } | Out-Null
try { Assert (-not ((Call GET '/auth/me' $o $null).features -contains 'AI_ASSISTANT')) 'global kill switch beats the plan' }
finally { Call PUT '/admin/flags' $admin @{ key = 'AI_ASSISTANT'; enabled = $null } | Out-Null }
Assert ((Call GET '/auth/me' $o $null).features -contains 'AI_ASSISTANT') 'kill switch lifted'

$plans = Call GET '/admin/plans' $admin $null
Assert (($plans | Measure-Object subscribers -Sum).Sum -ge 7) 'plan subscriber counts'
Expect-Fail POST '/admin/plans' $admin @{ code = 'STARTER'; name = 'Dup'; monthlyPrice = 1; annualPrice = 10; maxBranches = 1; maxUsers = 1; maxCustomers = 1 } 'CONFLICT'
$sys = Call GET '/admin/system' $admin $null
Assert ($sys.services.database.status -eq 'up' -and $sys.services.redis.status -eq 'up' -and $sys.queues.Count -ge 3) "system health db=$($sys.services.database.latencyMs)ms redis=$($sys.services.redis.latencyMs)ms"
$life = Call POST '/admin/jobs/subscriptions' $admin $null
Assert ($null -ne $life.trialReminders) "lifecycle ran: $($life | ConvertTo-Json -Compress)"
"Admin: flags, plans, health and lifecycle OK"

# 9. Suspension: manual suspend blocks the business; lapsed subscription is self-serve reactivated
$ff = Login 'owner@fitfix.demo'
$ffId = ((Page '/admin/tenants?search=fitfix' $admin).items | Select-Object -First 1).id
Expect-Fail PATCH "/admin/tenants/$ffId/status" $admin @{ status = 'SUSPENDED' } 'VALIDATION'
Call PATCH "/admin/tenants/$ffId/status" $admin @{ status = 'SUSPENDED'; reason = 'Smoke: payment overdue' } | Out-Null
try {
  Expect-Fail GET '/branches' $ff $null 'TENANT_SUSPENDED'
  $me = Call GET '/auth/me' $ff $null
  Assert ($me.tenantStatus -eq 'SUSPENDED' -and $me.suspendedReason -eq 'Smoke: payment overdue') 'session exposes the suspension'
  Assert ((Call GET '/subscription' $ff $null).subscription) 'subscription page still reachable'
  Call POST '/support/tickets' $ff @{ subject = 'Smoke: why suspended?'; description = 'Please help'; priority = 'HIGH' } | Out-Null
} finally { Call PATCH "/admin/tenants/$ffId/status" $admin @{ status = 'ACTIVE' } | Out-Null }
Call GET '/branches' $ff $null | Out-Null
Assert ((Call GET '/auth/me' $ff $null).tenantStatus -eq 'ACTIVE') 'reactivated'

$ss = Login 'owner@sereneskin.demo'
Assert ((Call GET '/auth/me' $ss $null).suspendedReason -eq 'Subscription lapsed') 'lapsed tenant suspended'
Expect-Fail GET '/customers' $ss $null 'TENANT_SUSPENDED'
$ssPlans = (Call GET '/subscription' $ss $null).plans
Call POST '/subscription/change' $ss @{ planId = ($ssPlans | Where-Object code -eq 'GROWTH').id; billingCycle = 'MONTHLY' } | Out-Null
Assert ((Call GET '/auth/me' $ss $null).tenantStatus -eq 'ACTIVE') 'resubscribing reactivates the business'
$ssId = ((Page '/admin/tenants?search=serene' $admin).items | Select-Object -First 1).id
Call PATCH "/admin/tenants/$ssId/subscription" $admin @{ status = 'CANCELLED' } | Out-Null
Call PATCH "/admin/tenants/$ssId/status" $admin @{ status = 'SUSPENDED'; reason = 'Subscription lapsed' } | Out-Null
"Suspension: manual suspend + reactivate, lapsed tenant self-served back (demo state restored)"

"M7 SMOKE PASSED"
