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
function OnHand($token, $productId, $branchId) {
  $p = Call GET "/products/$productId" $token $null
  $s = $p.stock | Where-Object branchId -eq $branchId
  if ($s) { [double]$s.quantity } else { 0 }
}

$o = Login 'owner@serenity.demo'
$inv = Login 'inventory@serenity.demo'
$branches = Call GET '/branches' $o $null
$ind = $branches | Where-Object code -eq 'IND'
$kor = $branches | Where-Object code -eq 'KOR'
$products = Call GET '/products' $o $null
$bySku = @{}; foreach ($p in $products) { $bySku[$p.sku] = $p }
$services = Call GET "/services?branchId=$($ind.id)&active=true" $o $null
$svc = @{}; foreach ($s in $services) { $svc[$s.name] = $s }

# 1. Stock overview + low stock
$stock = Page "/inventory/stock?branchId=$($ind.id)&pageSize=50" $inv
"Stock at IND: $($stock.meta.total) lines, value=$($stock.meta.summary.stockValue)"
Assert ($stock.meta.summary.stockValue -gt 0) 'stock has value'
$low = @(Call GET '/inventory/low-stock' $inv $null)
"Low stock: $(($low | ForEach-Object { "$($_.product.name)@$($_.branch.name)=$($_.quantity)" }) -join ', ')"
Assert ($low.Count -ge 3) 'seeded low-stock lines present'
$lowPage = Page '/inventory/stock?lowStock=true' $inv
Assert ($lowPage.meta.total -eq $low.Count) 'lowStock filter matches low-stock list'
$notLow = Page '/inventory/stock?lowStock=false&pageSize=1' $inv
Assert ($notLow.meta.total -gt $lowPage.meta.total) 'lowStock=false is not treated as true'

# 2. Purchase raises stock and moves cost to the weighted average
$balm = $bySku['RET-BALM-50']
$before = OnHand $inv $balm.id $ind.id
$purchase = Call POST '/inventory/purchases' $inv @{ branchId = $ind.id; supplierName = 'Smoke Supplier'; referenceNumber = 'SMK-1'; paymentMethod = 'UPI'; items = @(@{ productId = $balm.id; quantity = 10; unitCost = 140 }) }
$after = OnHand $inv $balm.id $ind.id
Assert ($after -eq $before + 10) "purchase adds 10 (before=$before after=$after)"
$balmNow = Call GET "/products/$($balm.id)" $inv $null
Assert ([double]$balmNow.costPrice -gt 120 -and [double]$balmNow.costPrice -lt 140) "weighted average cost between old and new ($($balmNow.costPrice))"
"Purchase $($purchase.id): balm $before -> $after, cost now $($balmNow.costPrice)"

# 3. Retail sale deducts stock; overselling is rejected; void returns the goods
$diff = $bySku['RET-DIFF']
$diffQty = OnHand $inv $diff.id $ind.id
$cart = Call POST '/carts' $o @{ branchId = $ind.id }
Call POST "/carts/$($cart.id)/items" $o @{ itemType = 'PRODUCT'; itemId = $diff.id; quantity = ([int]$diffQty + 1) } | Out-Null
Expect-Fail POST "/carts/$($cart.id)/checkout" $o @{ payments = @() } 'INSUFFICIENT_STOCK'
Assert ((OnHand $inv $diff.id $ind.id) -eq $diffQty) 'failed checkout leaves stock untouched'
Call POST "/carts/$($cart.id)/abandon" $o $null | Out-Null
"Oversell of $([int]$diffQty + 1) diffusers rejected (only $diffQty on hand)"

$cart = Call POST '/carts' $o @{ branchId = $ind.id }
$cart = Call POST "/carts/$($cart.id)/items" $o @{ itemType = 'PRODUCT'; itemId = $balm.id; quantity = 2 }
$sale = Call POST "/carts/$($cart.id)/checkout" $o @{ payments = @() }
Assert ((OnHand $inv $balm.id $ind.id) -eq $after - 2) 'sale deducts 2'
Call POST "/invoices/$($sale.id)/void" $o @{ reason = 'Smoke void returns goods' } | Out-Null
Assert ((OnHand $inv $balm.id $ind.id) -eq $after) 'void returns 2'
$txns = Page "/inventory/transactions?productId=$($balm.id)&pageSize=3" $inv
"Sale + void: $(($txns.items | ForEach-Object { "$($_.type)($($_.quantity))" }) -join ', ')"

# 4. Session consumption (service consumables + products used) is idempotent
$oil = $bySku['CON-OIL-BASE']; $sheet = $bySku['CON-SHEET']; $euc = $bySku['RET-EUC-30']
$oilBefore = OnHand $inv $oil.id $ind.id; $sheetBefore = OnHand $inv $sheet.id $ind.id; $eucBefore = OnHand $inv $euc.id $ind.id
$therapists = Call GET '/therapists' $o $null
$arjun = $therapists | Where-Object name -eq 'Arjun Das'
$busy = Page "/sessions?therapistId=$($arjun.id)&status=IN_PROGRESS,PAUSED" $o
foreach ($s in $busy.items) { Call POST "/sessions/$($s.id)/complete" $o @{} | Out-Null }
$cust = Call POST '/customers' $o @{ name = 'Smoke Inventory'; phone = "+9194$('{0:D8}' -f (Get-Random -Maximum 99999999))"; source = 'WALK_IN'; primaryBranchId = $ind.id }
$sess = Call POST '/sessions' $o @{ branchId = $ind.id; customerId = $cust.id; therapistId = $arjun.id; serviceId = $svc['Swedish Massage'].id; startNow = $true }
Call POST "/sessions/$($sess.id)/complete" $o @{ productsUsed = @(@{ productId = $euc.id; quantity = 1 }) } | Out-Null
Start-Sleep -Seconds 3
$oilAfter = OnHand $inv $oil.id $ind.id; $sheetAfter = OnHand $inv $sheet.id $ind.id; $eucAfter = OnHand $inv $euc.id $ind.id
Assert ($oilBefore - $oilAfter -eq 40) "swedish uses 40ml oil ($oilBefore -> $oilAfter)"
Assert ($sheetBefore - $sheetAfter -eq 1) 'swedish uses one sheet'
Assert ($eucBefore - $eucAfter -eq 1) 'products used deducted'
$consumed = Page "/inventory/transactions?type=CONSUMPTION&pageSize=5" $inv
Assert (@($consumed.items | Where-Object referenceId -eq $sess.id).Count -eq 3) 'three consumption rows for the session'
"Session consumption: oil -40ml, sheet -1, eucalyptus -1"

# 5. Adjustments, reorder level, RBAC on stock
Call POST '/inventory/reorder-level' $inv @{ branchId = $ind.id; productId = $euc.id; reorderLevel = ($eucAfter + 5) } | Out-Null
$low2 = @(Call GET "/inventory/low-stock?branchId=$($ind.id)" $inv $null)
Assert (@($low2 | Where-Object { $_.product.id -eq $euc.id }).Count -eq 1) 'raising reorder level flags low stock'
Call POST '/inventory/reorder-level' $inv @{ branchId = $ind.id; productId = $euc.id; reorderLevel = 5 } | Out-Null
Call POST '/inventory/adjustments' $inv @{ branchId = $ind.id; productId = $euc.id; type = 'DAMAGE'; quantity = 1; notes = 'Smoke broken bottle' } | Out-Null
Assert ((OnHand $inv $euc.id $ind.id) -eq $eucAfter - 1) 'damage removes stock'
$rt = Login 'reception@serenity.demo'
Expect-Fail POST '/inventory/adjustments' $rt @{ branchId = $ind.id; productId = $euc.id; type = 'ADJUSTMENT'; quantity = 5 } 'FORBIDDEN'
"Reorder level + damage OK; receptionist cannot adjust stock"

# 6. Transfers: request -> approve (stock out) -> receive (stock in); cancel returns stock
$lav = $bySku['RET-LAV-15']
$lavInd = OnHand $inv $lav.id $ind.id; $lavKor = OnHand $inv $lav.id $kor.id
$t = Call POST '/inventory/transfers' $inv @{ fromBranchId = $ind.id; toBranchId = $kor.id; items = @(@{ productId = $lav.id; quantity = 2 }) }
Expect-Fail POST '/inventory/transfers' $inv @{ fromBranchId = $ind.id; toBranchId = $ind.id; items = @(@{ productId = $lav.id; quantity = 2 }) } 'VALIDATION'
Expect-Fail POST "/inventory/transfers/$($t.id)/approve" $inv $null 'FORBIDDEN'
$t = Call POST "/inventory/transfers/$($t.id)/approve" $o $null
Assert ((OnHand $inv $lav.id $ind.id) -eq $lavInd - 2) 'approval dispatches stock'
$t = Call POST "/inventory/transfers/$($t.id)/receive" $inv $null
Assert ($t.status -eq 'COMPLETED' -and (OnHand $inv $lav.id $kor.id) -eq $lavKor + 2) 'receipt adds stock at destination'
Expect-Fail POST "/inventory/transfers/$($t.id)/receive" $inv $null 'INVALID_STATE'
$t2 = Call POST '/inventory/transfers' $inv @{ fromBranchId = $ind.id; toBranchId = $kor.id; items = @(@{ productId = $lav.id; quantity = 1 }) }
Call POST "/inventory/transfers/$($t2.id)/approve" $o $null | Out-Null
$t2 = Call POST "/inventory/transfers/$($t2.id)/cancel" $inv $null
Assert ($t2.status -eq 'CANCELLED' -and (OnHand $inv $lav.id $ind.id) -eq $lavInd - 2) 'cancel returns stock to source'
"Transfers: completed $($t.id), cancelled $($t2.id)"

# 7. Expenses: create, edit (reposts), delete (reverses); purchase-linked rows locked
$acc = Login 'accounts@serenity.demo'
$e = Call POST '/expenses' $acc @{ branchId = $ind.id; category = 'MAINTENANCE'; amount = 1234.5; expenseDate = (Get-Date -Format 'yyyy-MM-dd'); paymentMethod = 'CASH'; vendor = 'Smoke Plumber'; description = 'Leak fix' }
$e = Call PATCH "/expenses/$($e.id)" $acc @{ amount = 1500 }
Assert ([double]$e.amount -eq 1500) 'expense edited'
$list = Page "/expenses?branchId=$($ind.id)&pageSize=100" $acc
$locked = $list.items | Where-Object fromPurchase | Select-Object -First 1
if ($locked) { Expect-Fail PATCH "/expenses/$($locked.id)" $acc @{ amount = 1 } 'INVALID_STATE' }
Call DELETE "/expenses/$($e.id)" $acc $null | Out-Null
Expect-Fail GET "/expenses/$($e.id)" $acc $null 'NOT_FOUND'
Expect-Fail POST '/expenses' $rt @{ branchId = $ind.id; category = 'OTHER'; amount = 10; expenseDate = (Get-Date -Format 'yyyy-MM-dd') } 'FORBIDDEN'
"Expenses: total=$($list.meta.summary.total) categories=$(($list.meta.summary.byCategory | ForEach-Object { "$($_.category)=$($_.amount)" }) -join ', ')"

# 8. Reports + exports
$from = (Get-Date).AddDays(-90).ToString('yyyy-MM-dd'); $to = (Get-Date).ToString('yyyy-MM-dd')
$catalogue = @(Call GET '/reports' $o $null)
"Reports: $(($catalogue | ForEach-Object key) -join ', ')"
foreach ($r in $catalogue) {
  $rep = Call GET "/reports/$($r.key)?from=$from&to=$to&groupBy=week" $o $null
  Assert ($rep.metrics.Count -gt 0) "$($r.key) has metrics"
  "  $($r.key): $(($rep.metrics | Select-Object -First 3 | ForEach-Object { "$($_.label)=$($_.value)" }) -join ', ')"
}
$pnl = Call GET "/reports/pnl?from=$from&to=$to&groupBy=month" $o $null
$mgr = Login 'manager@serenity.demo'
Expect-Fail GET "/reports/pnl?from=$from&to=$to" $mgr $null 'FORBIDDEN'
Expect-Fail GET "/reports/nope?from=$from&to=$to" $o $null 'NOT_FOUND'
Expect-Fail GET "/reports/sales?from=2020-01-01&to=$to" $o $null 'VALIDATION'
foreach ($fmt in @('csv', 'xlsx', 'pdf')) {
  $res = Invoke-WebRequest -Uri "$base/reports/sales/export?from=$from&to=$to&format=$fmt" -Headers @{ Authorization = "Bearer $o" } -UseBasicParsing
  $bytes = if ($res.Content -is [byte[]]) { $res.Content } else { [Text.Encoding]::UTF8.GetBytes($res.Content) }
  $sig = [Text.Encoding]::ASCII.GetString($bytes[0..3])
  $ok = switch ($fmt) { 'csv' { $bytes.Length -gt 50 } 'xlsx' { $sig.StartsWith('PK') } 'pdf' { $sig -eq '%PDF' } }
  Assert $ok "$fmt export has the right signature"
  "Export $fmt : $($bytes.Length) bytes, $($res.Headers['Content-Disposition'])"
}

# 9. Dashboards per role
$ov = Call GET '/dashboard/overview' $o $null
Assert ($ov.alerts.lowStockCount -ge 3 -and $ov.trend.Count -eq 30) 'overview has alerts and a 30-day trend'
"Owner overview: today=$($ov.today.billed) month=$($ov.month.billed) change=$($ov.month.change)% lowStock=$($ov.alerts.lowStockCount)"
$fd = Call GET "/dashboard/front-desk?branchId=$($ind.id)" $rt $null
"Front desk: collectedToday=$($fd.collectedToday) waiting=$($fd.waiting) unbilled=$(@($fd.unbilled).Count) unpaid=$(@($fd.unpaid).Count)"
$tt = Login 'arjun@serenity.demo'
$td = Call GET '/dashboard/therapist' $tt $null
"Therapist: completedToday=$($td.today.completed) monthSessions=$($td.month.sessions) monthCommission=$($td.month.commission)"
$ad = Call GET '/dashboard/accounts' $acc $null
"Accounts: outstanding=$($ad.outstanding.amount) monthCollected=$($ad.month.collected) monthExpenses=$($ad.month.expenses.total)"
Expect-Fail GET '/dashboard/accounts' $rt $null 'FORBIDDEN'
Expect-Fail GET '/dashboard/overview' $tt $null 'FORBIDDEN'

# 10. Books still balance
$tb = Call GET '/ledger/trial-balance' $acc $null
Assert $tb.balanced 'trial balance balanced'
"Trial balance: debit=$($tb.totalDebit) credit=$($tb.totalCredit) inventory=$(($tb.rows | Where-Object code -eq '1200').balance) cogs=$(($tb.rows | Where-Object code -eq '5100').balance)"
"M5 smoke OK"
