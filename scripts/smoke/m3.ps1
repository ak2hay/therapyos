$ErrorActionPreference = 'Stop'
$base = 'http://localhost:4000/api/v1'

function Call($method, $path, $token, $body) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  $params = @{ Uri = "$base$path"; Method = $method; Headers = $headers; ContentType = 'application/json' }
  if ($null -ne $body) { $params.Body = ($body | ConvertTo-Json -Depth 10) }
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

function Expect-Fail($method, $path, $token, $body, $status) {
  try { Call $method $path $token $body | Out-Null; throw "Expected $status for $method $path but it succeeded" }
  catch { if ("$_" -notmatch "$status|$($status -replace '_', ' ')") { throw "Expected $status for $method $path, got: $_" } }
}

function Login($id) { (Call POST '/auth/login' $null @{ identifier = $id; password = 'Demo@12345' }).tokens.accessToken }

$o = Login 'owner@serenity.demo'
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$kor = $branches | Where-Object code -eq 'KOR'

# Customers + segments
$list = Page '/customers?pageSize=100' $o
$segments = $list.items | Group-Object { $_.metrics.segment } | ForEach-Object { "$($_.Name)=$($_.Count)" }
"Customers: total=$($list.meta.total) segments: $($segments -join ', ')"
$loyal = $list.items | Where-Object { $_.metrics.segment -eq 'LOYAL' } | Select-Object -First 1
$detail = Call GET "/customers/$($loyal.id)" $o $null
$timeline = Page "/customers/$($loyal.id)/timeline" $o
"Loyal customer $($detail.name): visits=$($detail.metrics.visitCount) avgInterval=$($detail.metrics.avgVisitIntervalDays) timeline=$($timeline.meta.total) upcoming=$($detail.appointments.Count)"

# Availability + booking + conflict
$services = Call GET "/services?branchId=$($ind.id)&active=true" $o $null
$swedish = $services | Where-Object name -eq 'Swedish Massage'
$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$slots = Call GET "/appointments/availability?branchId=$($ind.id)&serviceId=$($swedish.id)&date=$tomorrow" $o $null
$slot = $slots.slots | Select-Object -Last 1
"Availability ${tomorrow} swedish: slots=$($slots.slots.Count) price=$($slots.price) picked=$($slot.time) freeTherapists=$($slot.therapistIds.Count)"
$cust = Call POST '/customers' $o @{ name = 'Smoke Customer'; phone = "+9196$('{0:D8}' -f (Get-Random -Maximum 99999999))"; source = 'WALK_IN'; primaryBranchId = $ind.id }
$appt = Call POST '/appointments' $o @{ branchId = $ind.id; customerId = $cust.id; serviceId = $swedish.id; therapistId = $slot.therapistIds[0]; date = $tomorrow; startTime = $slot.time }
"Booked appointment $($appt.id) with $($appt.therapist.name) at $($slot.time) status=$($appt.status)"
Expect-Fail POST '/appointments' $o @{ branchId = $ind.id; customerId = $cust.id; serviceId = $swedish.id; therapistId = $slot.therapistIds[0]; date = $tomorrow; startTime = $slot.time } 'SLOT_UNAVAILABLE'
"Double booking rejected with SLOT_UNAVAILABLE"
Expect-Fail POST '/appointments' $o @{ branchId = $ind.id; customerId = $cust.id; serviceId = $swedish.id; date = '2020-01-06'; startTime = '10:00' } 'INVALID_STATE'
"Past booking rejected"
$moved = Call PATCH "/appointments/$($appt.id)" $o @{ status = 'CONFIRMED' }
"Confirmed: $($moved.status)"

# Walk-in flow: queue -> assign -> start -> complete
$foot = $services | Where-Object name -eq 'Foot Reflexology'
$entry = Call POST '/queue' $o @{ branchId = $ind.id; customer = @{ name = 'Smoke Walkin'; phone = "+9195$('{0:D8}' -f (Get-Random -Maximum 99999999))" }; serviceId = $foot.id }
"Walk-in token #$($entry.queueNumber) status=$($entry.status)"
$board = Call GET "/queue?branchId=$($ind.id)" $o $null
"Queue board: waiting=$($board.stats.waiting) inService=$($board.stats.inService) therapists=$(($board.therapists | ForEach-Object { "$($_.name):$($_.state)" }) -join ', ')"
$vikram = (Call GET '/therapists' $o $null) | Where-Object name -eq 'Vikram Singh'
$busy = Page "/sessions?therapistId=$($vikram.id)&status=IN_PROGRESS,PAUSED" $o
foreach ($s in $busy.items) { Call POST "/sessions/$($s.id)/complete" $o @{} | Out-Null }
Call POST "/queue/$($entry.id)/assign" $o @{ therapistId = $vikram.id } | Out-Null
$started = Call POST "/queue/$($entry.id)/start" $o @{ room = 'Room 2' }
"Started session $($started.session.id) status=$($started.session.status) entry=$($started.entry.status)"
Expect-Fail POST "/sessions" $o @{ branchId = $ind.id; customerId = $cust.id; therapistId = $vikram.id; serviceId = $foot.id; startNow = $true } 'THERAPIST_UNAVAILABLE'
"Second concurrent session for the same therapist rejected"

# Therapist view: own day, masked phone, pause/resume/complete
$vt = Login 'vikram@serenity.demo'
$day = Call GET '/sessions/my-day' $vt $null
"Vikram my-day: active=$($day.activeSession.customer.name) phone=$($day.activeSession.customer.phone) appointments=$($day.stats.appointments)"
Call POST "/sessions/$($started.session.id)/pause" $vt $null | Out-Null
Call POST "/sessions/$($started.session.id)/resume" $vt $null | Out-Null
$done = Call POST "/sessions/$($started.session.id)/complete" $vt @{ notes = 'Smoke test session' }
"Completed: status=$($done.status) elapsed=$($done.elapsedSeconds)s"
Start-Sleep -Seconds 4
$after = Call GET "/customers/$($started.session.customerId)" $o $null
"Walk-in metrics after completion: visits=$($after.metrics.visitCount) segment=$($after.metrics.segment)"
$board2 = Call GET "/queue?branchId=$($ind.id)" $o $null
$e2 = $board2.entries | Where-Object id -eq $entry.id
"Queue entry after completion: $($e2.status)"

# Appointment check-in -> start -> complete
$todayAppt = (Page "/appointments?branchId=$($ind.id)&from=$((Get-Date).ToString('yyyy-MM-dd'))&to=$((Get-Date).ToString('yyyy-MM-dd'))&status=BOOKED,CONFIRMED" $o).items | Select-Object -First 1
if ($todayAppt) {
  $qe = Call POST "/appointments/$($todayAppt.id)/check-in" $o $null
  "Checked in appointment -> token #$($qe.queueNumber) priority=$($qe.priority)"
  $sess = Call POST "/appointments/$($todayAppt.id)/start" $o @{}
  Call POST "/sessions/$($sess.id)/complete" $o @{} | Out-Null
  $a2 = Call GET "/appointments/$($todayAppt.id)" $o $null
  "Appointment after session: $($a2.status)"
}

# Cancel + RBAC / branch scope
$c = Call POST "/appointments/$($appt.id)/cancel" $o @{ reason = 'Smoke cancel' }
"Cancelled: $($c.status)"
$rt = Login 'reception@serenity.demo'
Expect-Fail GET "/queue?branchId=$($kor.id)" $rt $null 'FORBIDDEN'
"Indiranagar receptionist blocked from Koramangala queue"
$tt = Login 'arjun@serenity.demo'
Expect-Fail GET "/appointments/board?branchId=$($ind.id)&date=$tomorrow" $tt $null 'FORBIDDEN'
$own = Page '/appointments' $tt
"Therapist sees only own appointments: $((@($own.items | Select-Object -ExpandProperty therapist -Unique | Select-Object -ExpandProperty name -Unique)) -join ',') count=$($own.meta.total)"
$bd = Call GET "/appointments/board?branchId=$($ind.id)&date=$tomorrow" $o $null
"Board ${tomorrow}: therapists=$($bd.therapists.Count) appointments=$($bd.appointments.Count)"
"M3 smoke OK"

