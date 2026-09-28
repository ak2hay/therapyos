$ErrorActionPreference = 'Stop'
$root = 'http://localhost:4000'
$base = "$root/api/v1"

function Call($method, $path, $token, $body) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  $params = @{ Uri = "$base$path"; Method = $method; Headers = $headers; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $body) { $params.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 10)) }
  try { (Invoke-RestMethod @params).data }
  catch {
    $msg = $_.ErrorDetails.Message
    throw "$method $path failed: $msg"
  }
}

function Page($path, $token) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  $r = Invoke-RestMethod -Uri "$base$path" -Headers $headers
  [pscustomobject]@{ items = @($r.data); meta = $r.meta }
}

function Expect-Fail($method, $path, $token, $body, $status) {
  try { Call $method $path $token $body | Out-Null; throw "Expected $status for $method $path but it succeeded" }
  catch { if ("$_" -notmatch "$status|$($status -replace '_', ' ')") { throw "Expected $status for $method $path, got: $_" } }
}

function Assert($cond, $msg) { if (-not $cond) { throw "ASSERT FAILED: $msg" } }
function Login($id) { (Call POST '/auth/login' $null @{ identifier = $id; password = 'Demo@12345' }).tokens.accessToken }
function NewCustomer($token, $name, $branchId, $extra) {
  $body = @{ name = $name; phone = "+9192$('{0:D8}' -f (Get-Random -Maximum 99999999))"; source = 'WALK_IN'; primaryBranchId = $branchId }
  if ($extra) { foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] } }
  Call POST '/customers' $token $body
}
# Event handlers and notification delivery are asynchronous (outbox -> BullMQ); poll until they land.
function WaitFor($what, [scriptblock]$probe, $seconds = 20) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $r = & $probe
    if ($r) { return $r }
    Start-Sleep -Milliseconds 700
  }
  throw "Timed out waiting for $what"
}

$o = Login 'owner@serenity.demo'
$m = Login 'manager@serenity.demo'
$rc = Login 'reception@serenity.demo'
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$services = Call GET "/services?branchId=$($ind.id)&active=true" $o $null
$svc = @{}; foreach ($s in $services) { $svc[$s.name] = $s }
$therapists = Call GET '/therapists' $o $null
$vikram = $therapists | Where-Object name -eq 'Vikram Singh'

# 1. Templates: list, preview, custom override drives the next booking confirmation
$tpl = Call GET '/notifications/templates' $o $null
$booked = $tpl.events | Where-Object event -eq 'APPOINTMENT_BOOKED'
Assert (($booked.channels | Where-Object channel -eq 'WHATSAPP').effective.body -match 'customer_name') 'system WhatsApp template for bookings'
Assert ($tpl.variables -contains 'feedback_link') 'variables list exposed'
$pv = Call POST '/notifications/templates/preview' $o @{ body = 'Hi {{customer_name}}, see you at {{branch_name}} {{mystery}}'; subject = 'Hello {{customer_name}}' }
Assert ($pv.valid -and $pv.text -match 'Hi Priya' -and $pv.unknownVariables -contains 'mystery') "preview renders sample vars ($($pv.text))"
$bad = Call POST '/notifications/templates/preview' $o @{ body = 'Hi {{#if}}' }
Assert (-not $bad.valid) 'invalid template syntax reported'
Expect-Fail PUT '/notifications/templates' $o @{ event = 'APPOINTMENT_BOOKED'; channel = 'EMAIL'; name = 'x'; body = '<p>hi</p>' } 'VALIDATION'
Expect-Fail PUT '/notifications/templates' $m @{ event = 'APPOINTMENT_BOOKED'; channel = 'WHATSAPP'; name = 'x'; body = 'x' } 'FORBIDDEN'
$custom = Call PUT '/notifications/templates' $o @{ event = 'APPOINTMENT_BOOKED'; channel = 'WHATSAPP'; name = 'Smoke confirmation'; body = 'SMOKE {{customer_name}} booked {{service_name}} at {{branch_name}} on {{appointment_time}}' }
"Custom template $($custom.id) saved"

$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$slots = Call GET "/appointments/availability?branchId=$($ind.id)&serviceId=$($svc['Swedish Massage'].id)&date=$tomorrow" $o $null
$slot = $slots.slots | Select-Object -Last 1
$c1 = NewCustomer $o 'Smoke Notify One' $ind.id @{ email = "smoke.notify$(Get-Random)@example.com" }
$appt = Call POST '/appointments' $o @{ branchId = $ind.id; customerId = $c1.id; serviceId = $svc['Swedish Massage'].id; therapistId = $slot.therapistIds[0]; date = $tomorrow; startTime = $slot.time }
$logs = WaitFor 'booking confirmation' { $p = Page "/notifications/logs?customerId=$($c1.id)&event=APPOINTMENT_BOOKED" $o; if ($p.items.Count -ge 2 -and -not ($p.items | Where-Object status -eq 'QUEUED')) { $p } }
$wa = $logs.items | Where-Object channel -eq 'WHATSAPP'
$em = $logs.items | Where-Object channel -eq 'EMAIL'
Assert ($wa.status -eq 'SENT' -and $wa.body -match '^SMOKE Smoke booked Swedish Massage') "custom WhatsApp template used ($($wa.body))"
Assert ($em.status -eq 'SENT' -and $em.subject -match 'confirmed') 'system email template used alongside'
"Booking confirmation: WHATSAPP '$($wa.body)' + EMAIL '$($em.subject)'"
Call DELETE "/notifications/templates/$($custom.id)" $o $null | Out-Null
$tpl2 = Call GET '/notifications/templates' $o $null
Assert (-not (($tpl2.events | Where-Object event -eq 'APPOINTMENT_BOOKED').channels | Where-Object channel -eq 'WHATSAPP').custom) 'custom template reset'

# 2. Preferences: a disabled channel is skipped; WhatsApp off falls back to SMS
Call PUT '/notifications/preferences' $o @{ preferences = @(@{ event = 'APPOINTMENT_CANCELLED'; channel = 'WHATSAPP'; enabled = $false }) } | Out-Null
$prefs = Call GET '/notifications/preferences' $o $null
Assert (($prefs | Where-Object event -eq 'APPOINTMENT_CANCELLED').channels.WHATSAPP -eq $false) 'preference saved'
Call POST "/appointments/$($appt.id)/cancel" $o @{ reason = 'Smoke cancel' } | Out-Null
Start-Sleep -Seconds 4
$cancelLogs = Page "/notifications/logs?customerId=$($c1.id)&event=APPOINTMENT_CANCELLED" $o
Assert ($cancelLogs.meta.total -eq 0) 'disabled WhatsApp cancellation not sent (and not downgraded to SMS)'
Call PUT '/notifications/preferences' $o @{ preferences = @(@{ event = 'APPOINTMENT_CANCELLED'; channel = 'WHATSAPP'; enabled = $true }) } | Out-Null
"Preferences: disabled channel skipped, re-enabled"

Call PATCH '/settings' $o @{ WHATSAPP_ENABLED = $false } | Out-Null
try {
  $slot2 = ($slots.slots | Select-Object -Last 2)[0]
  $c2 = NewCustomer $o 'Smoke Notify Two' $ind.id $null
  Call POST '/appointments' $o @{ branchId = $ind.id; customerId = $c2.id; serviceId = $svc['Swedish Massage'].id; therapistId = $slot2.therapistIds[0]; date = $tomorrow; startTime = $slot2.time } | Out-Null
  $fb = WaitFor 'SMS fallback' { $p = Page "/notifications/logs?customerId=$($c2.id)&event=APPOINTMENT_BOOKED" $o; if ($p.items | Where-Object status -eq 'SENT') { $p } }
  Assert ($fb.items.Count -eq 1 -and $fb.items[0].channel -eq 'SMS') "WhatsApp disabled -> SMS fallback (got $($fb.items.channel -join ','))"
  "WhatsApp disabled: booking confirmation went by SMS"
} finally { Call PATCH '/settings' $o @{ WHATSAPP_ENABLED = $true } | Out-Null }

# 3. Test send
$test = Call POST '/notifications/test' $o @{ event = 'PAYMENT_RECEIVED'; channel = 'EMAIL'; to = 'owner.test@example.com' }
Assert ($test.status -eq 'SENT' -and $test.subject -match 'INV-') "test email sent ($($test.subject))"

# 4. Per-visit feedback link -> public rating -> low-rating escalation
$busy = Page "/sessions?therapistId=$($vikram.id)&status=IN_PROGRESS,PAUSED" $o
foreach ($s in $busy.items) { Call POST "/sessions/$($s.id)/complete" $o @{} | Out-Null }
$c3 = NewCustomer $o 'Smoke Feedback' $ind.id $null
$sess = Call POST '/sessions' $o @{ branchId = $ind.id; customerId = $c3.id; therapistId = $vikram.id; serviceId = $svc['Foot Reflexology'].id; startNow = $true }
Call POST "/sessions/$($sess.id)/complete" $o @{} | Out-Null
$req = WaitFor 'feedback request message' { $p = Page "/notifications/logs?customerId=$($c3.id)&event=FEEDBACK_REQUEST" $o; if ($p.items | Where-Object status -eq 'SENT') { $p.items[0] } }
Assert ($req.body -match '/f/([A-Za-z0-9_-]+)') "feedback link in message ($($req.body))"
$token = $Matches[1]
$info = Call GET "/public/feedback/$token" $null $null
Assert ($info.serviceName -eq 'Foot Reflexology' -and $info.therapistName -eq 'Vikram Singh' -and -not $info.used) 'public token info'
$thanks = Call POST "/public/feedback/$token" $null @{ rating = 2; comment = 'Smoke: therapist was late' }
Assert ($thanks.thanks -and -not $thanks.reviewUrl) 'low rating gets no review redirect'
Expect-Fail POST "/public/feedback/$token" $null @{ rating = 5 } 'CONFLICT'
Expect-Fail GET '/public/feedback/not-a-real-token' $null $null 'NOT_FOUND'
$alert = WaitFor 'low-rating alert' { $n = Call GET '/notifications/in-app' $m $null; $n.items | Where-Object { $_.type -eq 'LOW_RATING' -and $_.body -match 'Smoke: therapist was late' } | Select-Object -First 1 }
"Feedback via link: 2 stars -> manager alerted '$($alert.title)'"
$fbList = Page "/feedback?search=Smoke:%20therapist" $m
Assert ($fbList.items[0].source -eq 'IN_APP' -and $fbList.items[0].therapistName -eq 'Vikram Singh' -and $fbList.items[0].customer.name -eq 'Smoke Feedback') 'feedback stored with therapist and customer'

# 5. Branch QR: printable code, public page, happy rating invites a Google review
$qr = Call GET "/feedback/qr/$($ind.id)" $m $null
Assert ($qr.png -match '^data:image/png;base64,' -and $qr.url -match '/feedback/serenity-wellness/ind$') "QR for $($qr.url)"
$binfo = Call GET '/public/feedback/branch/serenity-wellness/ind' $null $null
Assert ($binfo.branchName -eq $ind.name) 'public branch info'
$qrThanks = Call POST '/public/feedback/branch/serenity-wellness/ind' $null @{ rating = 5; comment = 'Smoke QR lovely'; phone = $c3.phone }
Assert ($qrThanks.reviewUrl -match 'g.page') 'happy QR rating gets the review link'
$qrRow = (Page '/feedback?search=Smoke%20QR%20lovely' $m).items[0]
Assert ($qrRow.source -eq 'QR' -and $qrRow.customer.id -eq $c3.id) 'QR feedback matched to the customer by phone'
Expect-Fail GET '/public/feedback/branch/serenity-wellness/zzz' $null $null 'NOT_FOUND'

# 6. Manual entry + permissions + summary
$manual = Call POST '/feedback' $m @{ branchId = $ind.id; rating = 4; comment = 'Smoke manual entry'; source = 'MANUAL' }
Expect-Fail POST '/feedback' $rc @{ branchId = $ind.id; rating = 4 } 'FORBIDDEN'
$all = Page '/feedback?pageSize=5' $o
$sum = $all.meta.summary
Assert ($sum.count -gt 150 -and $sum.average -gt 3.5 -and $sum.average -le 5) "summary avg=$($sum.average) count=$($sum.count)"
Assert ((($sum.distribution | Measure-Object count -Sum).Sum) -eq $sum.count) 'distribution adds up'
$low = Page '/feedback?maxRating=2' $o
Assert (-not ($low.items | Where-Object { $_.rating -gt 2 })) 'maxRating filter'
"Feedback summary: avg=$($sum.average) count=$($sum.count) score=$($sum.score) low=$($sum.lowRatings) topTherapist=$($sum.byTherapist[0].name)"

# 7. Retention
$ret = Call GET '/retention/overview' $o $null
$segTotal = ($ret.segments | Measure-Object count -Sum).Sum
Assert ($segTotal -ge $ret.totals.visited) 'segments cover every customer with metrics'
Assert ($ret.totals.repeatRate -gt 0 -and $ret.totals.avgLifetimeValue -gt 0) 'repeat rate and LTV'
Assert ($ret.cohorts.Count -ge 3) 'monthly cohorts'
"Retention: customers=$($ret.totals.customers) repeat=$($ret.totals.repeatRate)% churn=$($ret.totals.churnRate)% avgLTV=$($ret.totals.avgLifetimeValue) atRiskValue=$($ret.totals.atRiskValue) cohorts=$($ret.cohorts.Count)"
$vip = Page '/retention/customers?segment=VIP&pageSize=50' $m
Assert ($vip.items.Count -gt 0 -and -not ($vip.items | Where-Object segment -ne 'VIP')) 'segment filter'
Assert (($vip.items[0].customer.phone) -match '^\+\d+$') 'manager holds contact permission and sees full phones'
Expect-Fail GET '/retention/overview' $rc $null 'FORBIDDEN'
$recomputed = Call POST '/retention/recompute' $o $null
Assert ($recomputed.customers -gt 80) 'recompute all'

# 8. Campaigns: audience -> send -> delivery -> attribution
$aud = Call POST '/campaigns/audience' $o @{ channel = 'SMS'; filters = @{ branchId = $ind.id } }
Assert ($aud.count -gt 0 -and $aud.excludedNoConsent -gt 0) "audience count=$($aud.count) excludedNoConsent=$($aud.excludedNoConsent)"
Expect-Fail POST '/campaigns' $m @{ name = 'x'; channel = 'SMS'; templateBody = 'x' } 'FORBIDDEN'
Expect-Fail POST '/campaigns' $o @{ name = 'Smoke bad'; channel = 'SMS'; templateBody = 'Hi {{#each}}' } 'VALIDATION'
$c4 = NewCustomer $o 'Smoke Campaign Target' $ind.id @{ marketingOptIn = $true }
$flat = (Call GET '/coupons' $o $null) | Where-Object code -eq 'FLAT250'
$camp = Call POST '/campaigns' $o @{ name = "Smoke campaign $(Get-Random)"; channel = 'SMS'; templateBody = 'Hi {{customer_name}}, {{offer_code}} gets you Rs 250 off at {{business_name}}'; filters = @{ branchId = $ind.id }; couponId = $flat.id }
Assert ($camp.status -eq 'DRAFT') 'created as draft'
$sent = Call POST "/campaigns/$($camp.id)/send" $o $null
Assert ($sent.status -eq 'COMPLETED' -and $sent.stats.sent -gt 0) "campaign sent to $($sent.stats.sent)/$($sent.stats.total)"
$campLogs = Page "/notifications/logs?campaignId=$($camp.id)&customerId=$($c4.id)" $o
Assert ($campLogs.items[0].body -match 'Hi Smoke, FLAT250 gets you') "personalised campaign message ($($campLogs.items[0].body))"
Expect-Fail POST "/campaigns/$($camp.id)/send" $o $null 'INVALID_STATE'
Expect-Fail DELETE "/campaigns/$($camp.id)" $o $null 'INVALID_STATE'

$cart = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c4.id }
$cart = Call POST "/carts/$($cart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Swedish Massage'].id; quantity = 1 }
$inv = Call POST "/carts/$($cart.id)/checkout" $o @{ payments = @(@{ method = 'CASH'; amount = $cart.quote.total }) }
Assert ($inv.status -eq 'PAID') 'target customer paid'
$conv = WaitFor 'campaign attribution' { $d = Call GET "/campaigns/$($camp.id)" $o $null; if ($d.stats.converted -ge 1) { $d } }
Assert ($conv.stats.revenue -eq $inv.total) "attributed revenue $($conv.stats.revenue) = invoice total $($inv.total)"
"Campaign $($conv.name): sent=$($conv.stats.sent) converted=$($conv.stats.converted) revenue=$($conv.stats.revenue)"

$draft = Call POST '/campaigns' $o @{ name = 'Smoke scheduled'; channel = 'EMAIL'; subject = 'Hi'; templateBody = '<p>Hi {{customer_name}}</p>' }
Expect-Fail POST "/campaigns/$($draft.id)/schedule" $o @{ scheduledAt = '2020-01-01T10:00:00+05:30' } 'VALIDATION'
$sched = Call POST "/campaigns/$($draft.id)/schedule" $o @{ scheduledAt = (Get-Date).AddDays(3).ToString('yyyy-MM-ddTHH:mm:sszzz') }
Assert ($sched.status -eq 'SCHEDULED') 'scheduled'
$cancelled = Call POST "/campaigns/$($draft.id)/cancel" $o $null
Assert ($cancelled.status -eq 'CANCELLED') 'cancelled'
Call DELETE "/campaigns/$($draft.id)" $o $null | Out-Null
$list = Page '/campaigns' $m
Assert ($list.meta.summary.converted -ge 9 -and $list.meta.summary.revenue -gt 17000) "campaign summary converted=$($list.meta.summary.converted) revenue=$($list.meta.summary.revenue)"

# 9. In-app notifications
$inv2 = Login 'inventory@serenity.demo'
$bell = Call GET '/notifications/in-app' $inv2 $null
Assert ($bell.unread -gt 0 -and ($bell.items | Where-Object type -eq 'STOCK_LOW')) "inventory manager sees low-stock alerts (unread=$($bell.unread))"
Call POST "/notifications/in-app/$($bell.items[0].id)/read" $inv2 $null | Out-Null
Expect-Fail POST "/notifications/in-app/$($bell.items[0].id)/read" $o $null 'NOT_FOUND'
Call POST '/notifications/in-app/read-all' $inv2 $null | Out-Null
Assert ((Call GET '/notifications/in-app' $inv2 $null).unread -eq 0) 'read-all clears unread'

# 10. Automation jobs + delivery log summary + queue dashboard
$status = Call GET '/automation/status' $o $null
Assert (@($status.schedulers).Count -ge 3) "job schedulers registered: $(($status.schedulers | ForEach-Object key) -join ', ')"
$rem = Call POST '/automation/jobs/reminders/run' $o $null
$daily = Call POST '/automation/jobs/daily/run' $o $null
Assert ($daily.result.metrics.customers -gt 80 -and $null -ne $daily.result.expiry) 'daily job ran every step'
"Automation: reminders due=$($rem.result.due) daily=$($daily.result.date) expiry=$($daily.result.expiry | ConvertTo-Json -Compress)"
Expect-Fail POST '/automation/jobs/nope/run' $o $null 'NOT_FOUND'
Expect-Fail POST '/automation/jobs/daily/run' $m $null 'FORBIDDEN'
$logSum = (Page '/notifications/logs?pageSize=1' $o).meta.summary
Assert ($logSum.last30Days.SENT -gt 20) "delivery log summary SENT=$($logSum.last30Days.SENT)"

try { Invoke-WebRequest -Uri "$root/admin/queues" -UseBasicParsing | Out-Null; throw 'queue dashboard should require auth' }
catch { Assert ("$_" -match '401|Authentication required') "queue dashboard protected ($_)" }
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('admin:admin'))
$qd = Invoke-WebRequest -Uri "$root/admin/queues" -Headers @{ Authorization = "Basic $basic" } -UseBasicParsing
Assert ($qd.StatusCode -eq 200) 'queue dashboard with credentials'

"M6 SMOKE PASSED"
