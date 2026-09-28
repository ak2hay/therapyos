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

function Assert($cond, $msg) { if (-not $cond) { throw "ASSERT FAILED: $msg" } }
function Login($id) { (Call POST '/auth/login' $null @{ identifier = $id; password = 'Demo@12345' }).tokens.accessToken }
function NewCustomer($token, $name, $branchId) { Call POST '/customers' $token @{ name = $name; phone = "+9193$('{0:D8}' -f (Get-Random -Maximum 99999999))"; source = 'WALK_IN'; primaryBranchId = $branchId } }

$o = Login 'owner@serenity.demo'
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$services = Call GET "/services?branchId=$($ind.id)&active=true" $o $null
$svc = @{}; foreach ($s in $services) { $svc[$s.name] = $s }

# Catalogue
$pkgs = Call GET '/packages?active=true' $o $null
$plans = Call GET '/membership-plans?active=true' $o $null
$offers = Call GET '/offers?current=true' $o $null
"Catalogue: packages=$($pkgs.Count) plans=$($plans.Count) liveOffers=$(($offers | ForEach-Object name) -join ', ')"
$swedishPkg = $pkgs | Where-Object name -eq 'Swedish Relax x5'
$gold = $plans | Where-Object name -eq 'Gold Wellness'

# 1. POS: offer + coupon + split payment
$c1 = NewCustomer $o 'Smoke Billing One' $ind.id
$cart = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c1.id }
$cart = Call POST "/carts/$($cart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Abhyanga'].id; quantity = 1 }
$cart = Call POST "/carts/$($cart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Swedish Massage'].id; quantity = 1 }
Expect-Fail PATCH "/carts/$($cart.id)" $o @{ couponCode = 'SUMMER15' } 'COUPON_EXPIRED'
$cart = Call PATCH "/carts/$($cart.id)" $o @{ couponCode = 'FLAT250' }
$q = $cart.quote
"Quote: subtotal=$($q.subtotal) offers=$($q.breakdown.offers) coupon=$($q.breakdown.coupon) tax=$($q.tax) rounding=$($q.rounding) total=$($q.total)"
Assert ($q.breakdown.offers -eq 200) 'Ayurveda Week 10% on Abhyanga (2000) should give 200'
Assert ($q.breakdown.coupon -eq 250) 'FLAT250 applies'
$expected = [math]::Round((3800 - 200 - 250) * 1.18)
Assert ($q.total -eq $expected) "total should be $expected"
$half = [math]::Round($q.total / 2)
$inv = Call POST "/carts/$($cart.id)/checkout" $o @{ payments = @(@{ method = 'CASH'; amount = $half }) }
Assert ($inv.status -eq 'PARTIALLY_PAID') "expected PARTIALLY_PAID got $($inv.status)"
"Checkout $($inv.invoiceNumber): status=$($inv.status) paid=$($inv.amountPaid) due=$($inv.balanceDue) coupon=$($inv.couponCode) offers=$(($inv.appliedOffers | ForEach-Object name) -join ',')"
Expect-Fail POST "/carts/$($cart.id)/checkout" $o @{ payments = @() } 'INVALID_STATE'
Expect-Fail POST "/invoices/$($inv.id)/payments" $o @{ method = 'UPI'; amount = ($inv.balanceDue + 1) } 'PAYMENT_EXCEEDS_BALANCE'
$inv = Call POST "/invoices/$($inv.id)/payments" $o @{ method = 'UPI'; amount = $inv.balanceDue; reference = 'UPI-SMOKE-1' }
Assert ($inv.status -eq 'PAID') 'invoice paid after remainder'
"Remainder paid by UPI: status=$($inv.status) paid=$($inv.amountPaid)"

# 2. Package sale paid through the (mock) gateway
$c2 = NewCustomer $o 'Smoke Package Buyer' $ind.id
$pinv = Call POST '/customer-packages/sell' $o @{ customerId = $c2.id; packageId = $swedishPkg.id; branchId = $ind.id }
$pending = Page "/customer-packages?customerId=$($c2.id)" $o
Assert ($pending.items[0].status -eq 'PENDING_PAYMENT') 'package pending until paid'
$order = Call POST '/payments/gateway/order' $o @{ invoiceId = $pinv.id }
"Gateway order $($order.orderId) amount=$($order.amount) mock=$($order.mock)"
$pinv = Call POST "/payments/$($order.paymentId)/mock-complete" $o $null
$cp = (Page "/customer-packages?customerId=$($c2.id)" $o).items[0]
Assert ($pinv.status -eq 'PAID' -and $cp.status -eq 'ACTIVE') 'package active after gateway payment'
"Package invoice $($pinv.invoiceNumber) PAID; package $($cp.package.name) ACTIVE remaining=$($cp.remainingSessions) expires=$($cp.expiresAt)"

# 3. Session on the package -> auto redemption -> zero bill (idempotent)
$therapists = Call GET '/therapists' $o $null
$vikram = $therapists | Where-Object name -eq 'Vikram Singh'
$busy = Page "/sessions?therapistId=$($vikram.id)&status=IN_PROGRESS,PAUSED" $o
foreach ($s in $busy.items) { Call POST "/sessions/$($s.id)/complete" $o @{} | Out-Null }
$sess = Call POST '/sessions' $o @{ branchId = $ind.id; customerId = $c2.id; therapistId = $vikram.id; serviceId = $svc['Swedish Massage'].id; customerPackageId = $cp.id; startNow = $true }
Call POST "/sessions/$($sess.id)/complete" $o @{ notes = 'Package session' } | Out-Null
Start-Sleep -Seconds 3
$cpAfter = Call GET "/customer-packages/$($cp.id)" $o $null
Assert ($cpAfter.usedSessions -eq 1) "package redeemed once by session.completed (used=$($cpAfter.usedSessions))"
$scart = Call POST '/invoices/from-session' $o @{ sessionId = $sess.id }
$line = $scart.quote.lines[0]
"Session bill: covered=$($line.coveredQuantity) by $($line.coverage.label) total=$($scart.quote.total)"
Assert ($scart.quote.total -eq 0) 'package-covered session bills at zero'
$sinv = Call POST "/carts/$($scart.id)/checkout" $o @{ payments = @() }
$cpAfter = Call GET "/customer-packages/$($cp.id)" $o $null
Assert ($sinv.status -eq 'PAID' -and $cpAfter.usedSessions -eq 1) 'zero invoice PAID and no double redemption'
"Zero invoice $($sinv.invoiceNumber) status=$($sinv.status); package used=$($cpAfter.usedSessions)/$($cpAfter.totalSessions)"
Expect-Fail POST '/invoices/from-session' $o @{ sessionId = $sess.id } 'CONFLICT'

# 4. Redeem until exhausted
for ($i = 0; $i -lt 4; $i++) { Call POST "/customer-packages/$($cp.id)/redeem" $o @{ serviceId = $svc['Swedish Massage'].id; branchId = $ind.id } | Out-Null }
$cpAfter = Call GET "/customer-packages/$($cp.id)" $o $null
Assert ($cpAfter.status -eq 'EXHAUSTED') 'package exhausted'
Expect-Fail POST "/customer-packages/$($cp.id)/redeem" $o @{ serviceId = $svc['Swedish Massage'].id; branchId = $ind.id } 'PACKAGE_EXHAUSTED'
Expect-Fail POST "/customer-packages/$($cp.id)/redeem" $o @{ serviceId = $svc['Abhyanga'].id; branchId = $ind.id } 'PACKAGE_SERVICE_NOT_INCLUDED'
"Package exhausted after 5 redemptions; further redemption rejected"
$rev = Call POST "/customer-packages/redemptions/$($cpAfter.redemptions[0].id)/reverse" $o @{ reason = 'Smoke reversal' }
$cpAfter = Call GET "/customer-packages/$($cp.id)" $o $null
Assert ($cpAfter.status -eq 'ACTIVE' -and $cpAfter.remainingSessions -eq 1) 'reversal restores a session'
"Reversal restored: status=$($cpAfter.status) remaining=$($cpAfter.remainingSessions)"

# 5. Membership: sell, pay, discount + included session
$c3 = NewCustomer $o 'Smoke Gold Member' $ind.id
$minv = Call POST '/memberships/sell' $o @{ customerId = $c3.id; membershipPlanId = $gold.id; branchId = $ind.id }
$minv = Call POST "/invoices/$($minv.id)/payments" $o @{ method = 'CARD'; amount = $minv.balanceDue }
$active = @(Call GET "/memberships/active?customerId=$($c3.id)" $o $null)
Assert ($active.Count -eq 1) 'membership active after payment'
$mcart = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c3.id }
$mcart = Call POST "/carts/$($mcart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Deep Tissue Massage'].id; quantity = 1 }
$mcart = Call POST "/carts/$($mcart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Head, Neck & Shoulder'].id; quantity = 1; customerMembershipId = $active[0].id }
"Member quote: membershipDiscount=$($mcart.quote.breakdown.membership) covered=$($mcart.quote.breakdown.covered) total=$($mcart.quote.total)"
Assert ($mcart.quote.breakdown.membership -eq 330) 'Gold 15% on Deep Tissue (2200)'
Assert ($mcart.quote.breakdown.covered -eq 900) 'Head & shoulder included'
$mi = Call POST "/carts/$($mcart.id)/checkout" $o @{ payments = @(@{ method = 'UPI'; amount = $mcart.quote.total }) }
$m = Call GET "/memberships/$($active[0].id)" $o $null
$inc = $m.benefits | Where-Object type -eq 'INCLUDED_SESSIONS'
Assert ($inc.remaining -eq 2) 'one included session used'
"Member invoice $($mi.invoiceNumber) PAID; included sessions left=$($inc.remaining)"

# 6. Webhook: signature check + idempotent capture
$c4 = NewCustomer $o 'Smoke Webhook' $ind.id
$wcart = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c4.id }
Call POST "/carts/$($wcart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Foot Spa'].id; quantity = 1 } | Out-Null
$winv = Call POST "/carts/$($wcart.id)/checkout" $o @{ payments = @() }
$worder = Call POST '/payments/gateway/order' $o @{ invoiceId = $winv.id }
$payload = @{ event = 'payment.captured'; payload = @{ payment = @{ entity = @{ id = 'pay_webhook_smoke'; order_id = $worder.orderId; amount = $worder.amountMinor } } } } | ConvertTo-Json -Depth 10 -Compress
$hmac = New-Object System.Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes('mock_gateway_secret'))
$sig = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($payload)) | ForEach-Object { $_.ToString('x2') })
try { Invoke-RestMethod -Uri "$base/webhooks/razorpay" -Method POST -ContentType 'application/json' -Body $payload -Headers @{ 'x-razorpay-signature' = 'bad' } | Out-Null; throw 'bad signature accepted' }
catch { if ("$($_.ErrorDetails.Message)" -notmatch 'WEBHOOK_SIGNATURE_INVALID') { throw "Expected WEBHOOK_SIGNATURE_INVALID, got $_" } }
$w1 = Invoke-RestMethod -Uri "$base/webhooks/razorpay" -Method POST -ContentType 'application/json' -Body $payload -Headers @{ 'x-razorpay-signature' = $sig }
$w2 = Invoke-RestMethod -Uri "$base/webhooks/razorpay" -Method POST -ContentType 'application/json' -Body $payload -Headers @{ 'x-razorpay-signature' = $sig }
$winv = Call GET "/invoices/$($winv.id)" $o $null
$succ = @($winv.payments | Where-Object status -eq 'SUCCESS')
Assert ($winv.status -eq 'PAID' -and $succ.Count -eq 1) 'webhook captured exactly once'
"Webhook: bad signature rejected; delivered twice -> invoice $($winv.status) with $($succ.Count) payment"

# 7. Refunds
$pay = $inv.payments | Where-Object method -eq 'UPI'
Expect-Fail POST '/payments/refunds' $o @{ paymentId = $pay.id; amount = ($pay.amount + 1); reason = 'Too much' } 'REFUND_EXCEEDS_PAYMENT'
$rt = Login 'reception@serenity.demo'
Expect-Fail POST '/payments/refunds' $rt @{ paymentId = $pay.id; amount = 100; reason = 'Reception attempt' } 'FORBIDDEN'
$after = Call POST '/payments/refunds' $o @{ paymentId = $pay.id; amount = 500; reason = 'Goodwill adjustment' }
Assert ($after.amountRefunded -eq 500) 'refund recorded'
"Refund: invoice $($after.invoiceNumber) refunded=$($after.amountRefunded) status=$($after.status)"

# 8. Void
$vcart = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c4.id }
Call POST "/carts/$($vcart.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Facial'].id; quantity = 1 } | Out-Null
Call PATCH "/carts/$($vcart.id)" $o @{ couponCode = 'WELCOME10' } | Out-Null
$vinv = Call POST "/carts/$($vcart.id)/checkout" $o @{ payments = @() }
$voided = Call POST "/invoices/$($vinv.id)/void" $o @{ reason = 'Created by mistake' }
Assert ($voided.status -eq 'CANCELLED') 'void'
Expect-Fail POST "/invoices/$($inv.id)/void" $o @{ reason = 'Should fail' } 'INVALID_STATE'
Expect-Fail POST "/invoices/$($voided.id)/payments" $o @{ method = 'CASH'; amount = 10 } 'INVOICE_NOT_PAYABLE'
$reuse = Call POST '/carts' $o @{ branchId = $ind.id; customerId = $c4.id }
Call POST "/carts/$($reuse.id)/items" $o @{ itemType = 'SERVICE'; itemId = $svc['Facial'].id; quantity = 1 } | Out-Null
$reuse = Call PATCH "/carts/$($reuse.id)" $o @{ couponCode = 'WELCOME10' }
Assert ($reuse.quote.coupon.amount -gt 0) 'voiding released the per-customer coupon use'
Call POST "/carts/$($reuse.id)/abandon" $o $null | Out-Null
"Void: $($voided.invoiceNumber) CANCELLED; paid invoice cannot be voided; coupon use released"

# 9. PDF, lists, ledger, RBAC
$pdf = Invoke-WebRequest -Uri "$base/invoices/$($inv.id)/pdf" -Headers @{ Authorization = "Bearer $o" } -UseBasicParsing
$head = [Text.Encoding]::ASCII.GetString($pdf.Content[0..3])
Assert ($pdf.Headers['Content-Type'] -like 'application/pdf*' -and $head -eq '%PDF') 'pdf'
"PDF: $($pdf.Content.Length) bytes, $($pdf.Headers['Content-Disposition'])"
$list = Page "/invoices?branchId=$($ind.id)&pageSize=5" $o
"Invoices: total=$($list.meta.total) billed=$($list.meta.summary.total) paid=$($list.meta.summary.paid)"
$pl = Page '/payments?pageSize=5' $o
"Payments by method: $(($pl.meta.summary | ForEach-Object { "$($_.method)=$($_.net)" }) -join ', ')"
$acc = Login 'accounts@serenity.demo'
$tb = Call GET '/ledger/trial-balance' $acc $null
Assert $tb.balanced 'trial balance balanced'
"Trial balance: debit=$($tb.totalDebit) credit=$($tb.totalCredit) balanced=$($tb.balanced) AR=$(($tb.rows | Where-Object code -eq '1100').balance)"
$tt = Login 'arjun@serenity.demo'
Expect-Fail GET '/invoices' $tt $null 'FORBIDDEN'
Expect-Fail POST '/carts' $acc @{ branchId = $ind.id } 'FORBIDDEN'
"RBAC: therapist blocked from invoices, accountant blocked from POS"
"M4 smoke OK"
