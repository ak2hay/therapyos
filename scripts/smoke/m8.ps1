$ErrorActionPreference = 'Stop'
$base = 'http://localhost:4000/api/v1'

function Call($method, $path, $token, $body) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  $params = @{ Uri = "$base$path"; Method = $method; Headers = $headers; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $body) { $params.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 10)) }
  try { (Invoke-RestMethod @params).data }
  catch { throw "$method $path failed: $($_.ErrorDetails.Message)" }
}
function Page($path, $token) {
  $r = Invoke-RestMethod -Uri "$base$path" -Headers @{ Authorization = "Bearer $token" }
  [pscustomobject]@{ items = @($r.data); meta = $r.meta }
}
function Expect-Fail($method, $path, $token, $body, $status) {
  try { Call $method $path $token $body | Out-Null; throw "Expected $status for $method $path but it succeeded" }
  catch { if ("$_" -notmatch "$status|$($status -replace '_', ' ')") { throw "Expected $status for $method $path, got: $_" } }
}
function Assert($cond, $msg) { if (-not $cond) { throw "ASSERT FAILED: $msg" } }
# Logins are throttled (5/min per route); wait out the window instead of failing.
function Login($id, $password = 'Demo@12345') {
  for ($i = 0; $i -lt 6; $i++) {
    try { return (Call POST '/auth/login' $null @{ identifier = $id; password = $password }).tokens.accessToken }
    catch { if ("$_" -match 'TOO_MANY|Too Many|429') { Start-Sleep -Seconds 15 } else { throw } }
  }
  throw "Login throttled for $id"
}

# The assistant allows 20 questions a minute per user; wait out the window on repeated runs.
function Ask($token, $body) {
  for ($i = 0; $i -lt 6; $i++) {
    try { return Call POST '/ai/ask' $token $body }
    catch { if ("$_" -match 'RATE_LIMITED|429') { Start-Sleep -Seconds 15 } else { throw } }
  }
  throw 'AI ask throttled'
}

$o = Login 'owner@serenity.demo'
$m = Login 'manager@serenity.demo'
$rc = Login 'reception@serenity.demo'
$starter = Login 'owner@mindfulcare.demo'
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$kor = $branches | Where-Object code -eq 'KOR'

# 1. AI assistant: every suggested question maps to its tool and returns grounded numbers
$sugg = Call GET '/ai/suggestions' $o $null
Assert ($sugg.questions.Count -ge 6) 'suggested questions'
$expected = @{
  'Why did revenue fall this week?' = 'revenue_change'
  'Which customers should we contact this week?' = 'contact_customers'
  'Which services are growing?' = 'service_trends'
  'Which branches have declining repeat visits?' = 'repeat_visits'
  'What time slots have the highest demand?' = 'peak_times'
  'Which branches need operational attention?' = 'branch_attention'
}
foreach ($q in $expected.Keys) {
  $a = Ask $o @{ question = $q }
  Assert ($a.intent -eq $expected[$q]) "'$q' routed to $($a.intent)"
  Assert ($a.headline -and $a.answer) "'$q' has a headline and answer"
  Assert ($a.suggestions.Count -ge 1) "'$q' offers follow-ups"
  "AI [$($a.intent)] via $($a.provider): $($a.headline)"
}

# Revenue answer numbers must match the sales report for the same dates
$rev = Ask $o @{ question = 'How did revenue change last month?' }
$cur = $rev.metrics.current
$report = Call GET "/reports/sales?from=$($rev.period.from)&to=$($rev.period.to)" $o $null
$reportNet = ($report.metrics | Where-Object key -eq 'net').value
Assert ([math]::Abs($cur.revenue - $reportNet) -lt 1) "AI net sales ($($cur.revenue)) match the sales report ($reportNet)"
Assert ($rev.period.label -eq (Get-Date).AddMonths(-1).ToString('MMMM', [Globalization.CultureInfo]::InvariantCulture)) "period label ($($rev.period.label))"
$peak = Ask $o @{ question = 'When are we busiest?' }
Assert ($peak.heatmap.days.Count -eq 7 -and $peak.heatmap.values.Count -eq 7) 'peak heatmap'
$explicit = Ask $o @{ question = 'How were sales?'; from = $rev.period.from; to = $rev.period.to }
Assert ($explicit.metrics.current.revenue -eq $cur.revenue) 'explicit dates override the wording'

# Branch filter narrows the answer; branch staff cannot use the assistant
$scoped = Ask $o @{ question = 'How did revenue change last month?'; branchId = $ind.id }
Assert ($scoped.metrics.current.revenue -le $cur.revenue) 'branch answer is a subset'
Assert (-not $scoped.table) 'single-branch answer has no branch table'
Expect-Fail POST '/ai/ask' $rc @{ question = 'Why did revenue fall?' } 'FORBIDDEN'
Expect-Fail POST '/ai/ask' $o @{ question = 'x' } 'VALIDATION'
Expect-Fail POST '/ai/ask' $starter @{ question = 'Why did revenue fall?' } 'FEATURE_DISABLED'
$hist = Page '/ai/history?pageSize=5' $o
Assert ($hist.items.Count -ge 5 -and $hist.items[0].question -eq 'How did revenue change last month?') 'history is newest first'
Assert ($hist.items[0].headline) 'history keeps the structured answer'
"AI: last month $($cur.revenue) from $($cur.invoices) bills; IND $($scoped.metrics.current.revenue); history $($hist.meta.total)"

# 2. Advanced analytics
$from = (Get-Date).AddDays(-29).ToString('yyyy-MM-dd'); $to = (Get-Date).ToString('yyyy-MM-dd')
$an = Call GET "/analytics/overview?from=$from&to=$to" $o $null
Assert ($an.range.days -eq 30) "30 day range ($($an.range.days))"
Assert ($an.trend.Count -eq 30) 'daily trend covers the range'
$trendSum = [math]::Round((($an.trend | Measure-Object revenue -Sum).Sum), 2)
Assert ([math]::Abs($trendSum - $an.current.revenue) -lt 1) "trend adds up to revenue ($trendSum vs $($an.current.revenue))"
$sales = Call GET "/reports/sales?from=$from&to=$to" $o $null
$salesNet = ($sales.metrics | Where-Object key -eq 'net').value
Assert ([math]::Abs($an.current.revenue - $salesNet) -lt 1) "analytics net sales match the sales report ($($an.current.revenue) vs $salesNet)"
Assert ($an.cohorts.Count -eq 6 -and $an.cohorts[0].retention.Count -eq 5) 'six monthly cohorts'
Assert ($an.services.Count -ge 1 -and $an.therapists.Count -ge 1) 'service mix and therapist table'
$share = [math]::Round((($an.services | Measure-Object share -Sum).Sum), 0)
Assert ([math]::Abs($share - 100) -le 1) "service shares add to 100 ($share)"
Assert ($an.payments.Count -ge 1) 'payment mix'
$ma = Call GET "/analytics/overview?from=$from&to=$to" $m $null
Assert ($ma.current.revenue -le $an.current.revenue) 'manager sees only their branch'
Expect-Fail GET "/analytics/overview?from=$from&to=$to" $rc $null 'FORBIDDEN'
Expect-Fail GET "/analytics/overview?from=$from&to=$to" $starter $null 'FEATURE_DISABLED'
Expect-Fail GET "/analytics/overview?from=$to&to=$from" $o $null 'VALIDATION'
"Analytics: revenue $($an.current.revenue) (prev $($an.previous.revenue)), returning $($an.current.returningRate)%, top service $($an.services[0].name), manager $($ma.current.revenue)"

# 3. Customer app portal: OTP sign-in, sign-up, booking, wallet, purchase and isolation
function Otp($slug, $phone) {
  for ($i = 0; $i -lt 6; $i++) {
    try { return (Call POST '/portal/auth/send-otp' $null @{ tenantSlug = $slug; phone = $phone }).devCode }
    catch { if ("$_" -match 'wait before|RATE_LIMITED|TOO_MANY|429') { Start-Sleep -Seconds 12 } else { throw } }
  }
  throw "OTP throttled for $phone"
}
$code = Otp 'serenity-wellness' '9845010036'
Assert ($code -match '^\d{6}$') 'dev OTP returned outside production'
Expect-Fail POST '/portal/auth/verify-otp' $null @{ tenantSlug = 'serenity-wellness'; phone = '9845010036'; code = '000000' } 'OTP_INVALID'
$login = Call POST '/portal/auth/verify-otp' $null @{ tenantSlug = 'serenity-wellness'; phone = '9845010036'; code = $code }
Assert ($login.customer.phone -eq '+919845010036') 'local number matched the stored +91 number'
$ct = $login.tokens.accessToken
$me = Call GET '/portal/me' $ct $null
Assert ($me.name -eq 'Aarav Kapoor' -and $me.business.slug -eq 'serenity-wellness') 'customer profile'
Expect-Fail GET '/customers' $ct $null 'FORBIDDEN'
Expect-Fail GET '/portal/me' $o $null 'FORBIDDEN'
$near = Call GET '/portal/branches?lat=12.9716&lng=77.6412' $ct $null
Assert ($near[0].code -eq 'IND' -and $near[0].distanceKm -lt 1 -and $near[1].distanceKm -gt 3) "nearest centre first ($($near[0].code) $($near[0].distanceKm) km)"
$cat = Call GET '/portal/catalog' $ct $null
$svc = $cat.services | Where-Object { $_.durationMinutes -le 60 } | Select-Object -First 1
$date = (Get-Date).AddDays(3).ToString('yyyy-MM-dd')
$sl = Call GET "/portal/slots?branchId=$($ind.id)&serviceId=$($svc.id)&date=$date" $ct $null
Assert ($sl.slots.Count -ge 1) 'open slots'
$slot = $sl.slots[[math]::Floor($sl.slots.Count / 2)]
$appt = Call POST '/portal/appointments' $ct @{ branchId = $ind.id; serviceId = $svc.id; date = $date; startTime = $slot.time; notes = 'Smoke app booking' }
Assert ($appt.status -eq 'BOOKED' -and $appt.canCancel) 'booked from the app'
$staffView = Call GET "/appointments/$($appt.id)" $o $null
Assert ($staffView.source -eq 'CUSTOMER_APP') 'staff see the app booking source'
$up = Call GET '/portal/appointments?scope=upcoming' $ct $null
Assert (@($up | Where-Object id -eq $appt.id).Count -eq 1) 'appears in upcoming'
$cancelled = Call POST "/portal/appointments/$($appt.id)/cancel" $ct @{ reason = 'Smoke test' }
Assert ($cancelled.status -eq 'CANCELLED') 'customer cancelled'
$summary = Call GET '/portal/home' $ct $null
Assert ($null -ne $summary.sessionsLeft -and $summary.customer.id -eq $me.id) 'home summary'
$pk = Call GET '/portal/packages' $ct $null
$ms = Call GET '/portal/memberships' $ct $null
$off = Call GET '/portal/offers' $ct $null
Assert ($off.coupons | Where-Object code -eq 'WELCOME10') 'public coupons listed'
Assert (-not ($off.coupons | Where-Object code -eq 'SUMMER15')) 'expired coupons hidden'
$store = Call GET '/portal/store' $ct $null
Assert ($store.packages.Count -ge 1 -and $store.memberships.Count -ge 1) 'store'
$inv = @(Call GET '/portal/invoices' $ct $null)
Assert ($inv.Count -ge 1) 'invoice history'
$pdf = Invoke-WebRequest -Uri "$base/portal/invoices/$($inv[0].id)/pdf" -Headers @{ Authorization = "Bearer $ct" } -UseBasicParsing
Assert ($pdf.Headers['Content-Type'] -match 'pdf') 'invoice pdf'
$other = Page '/invoices?pageSize=50' $o
$foreign = $other.items | Where-Object { $_.customer.id -and $_.customer.id -ne $me.id } | Select-Object -First 1
Expect-Fail GET "/portal/invoices/$($foreign.id)/pdf" $ct $null 'NOT_FOUND'
Expect-Fail POST "/portal/invoices/$($foreign.id)/pay" $ct $null 'NOT_FOUND'
$updated = Call PATCH '/portal/me' $ct @{ whatsappOptIn = $me.whatsappOptIn; gender = 'MALE' }
Assert ($updated.gender -eq 'MALE') 'profile update'
$rot = Call POST '/portal/auth/refresh' $null @{ refreshToken = $login.tokens.refreshToken }
Assert ($rot.accessToken) 'refresh rotates'
Expect-Fail POST '/portal/auth/refresh' $null @{ refreshToken = $login.tokens.refreshToken } 'TOKEN_REUSED'
Expect-Fail POST '/auth/refresh' $null @{ refreshToken = $rot.refreshToken } 'UNAUTHENTICATED'

# New customer sign-up through a signup token; a starter tenant without the feature is hidden
$newPhone = '98' + (Get-Random -Minimum 10000000 -Maximum 99999999)
$code2 = Otp 'serenity-wellness' $newPhone
$v = Call POST '/portal/auth/verify-otp' $null @{ tenantSlug = 'serenity-wellness'; phone = $newPhone; code = $code2 }
Assert ($v.needsProfile -and $v.signupToken) 'unknown number needs a profile'
Expect-Fail GET '/portal/me' $v.signupToken $null 'UNAUTHENTICATED'
$reg = Call POST '/portal/auth/register' $null @{ signupToken = $v.signupToken; name = 'Smoke App Customer'; branchId = $kor.id }
Assert ($reg.customer.phone -eq "+91$newPhone") 'registered with E.164 phone'
$newCust = Call GET "/customers/$($reg.customer.id)" $o $null
Assert ($newCust.source -eq 'CUSTOMER_APP') 'sign-up attributed to the customer app'
$nt = $reg.tokens.accessToken
$buy = Call POST '/portal/purchase' $nt @{ itemType = 'PACKAGE'; itemId = $store.packages[0].id; branchId = $kor.id }
Assert ($buy.order.mock -and $buy.order.amount -gt 0) "purchase opened a gateway order ($($buy.order.amount))"
Expect-Fail POST "/portal/payments/$($buy.order.paymentId)/mock-complete" $ct $null 'NOT_FOUND'
$paid = Call POST "/portal/payments/$($buy.order.paymentId)/mock-complete" $nt $null
Assert ($paid.status -eq 'PAID') 'purchase paid'
$pk2 = @(Call GET '/portal/packages' $nt $null)
Assert ($pk2.Count -eq 1 -and $pk2[0].status -eq 'ACTIVE' -and $pk2[0].remaining -gt 0) 'purchased package is active'
$ninv = @(Call GET '/portal/invoices' $nt $null)
Assert ($ninv[0].id -eq $buy.invoiceId -and $ninv[0].balance -eq 0) 'purchase invoice settled'
Expect-Fail POST '/portal/auth/send-otp' $null @{ tenantSlug = 'mindful-care'; phone = '9845010036' } 'NOT_FOUND'
"Portal: $($me.name) booked+cancelled $($svc.name) at $($slot.time), $(@($pk).Count) packages, $(@($ms).Count) memberships, $($off.offers.Count) offers; new customer $($reg.customer.phone) bought $($store.packages[0].name) ($($buy.order.amount))"

'M8 smoke passed'

