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

$stamp = Get-Random -Maximum 99999
$reg = Call POST '/auth/register' $null @{ businessName = "Smoke Spa $stamp"; ownerName = 'Smoke Owner'; email = "smoke$stamp@test.dev"; phone = "+9197$('{0:D8}' -f $stamp)"; password = 'Smoke@12345' }
$t = $reg.tokens.accessToken
"Registered tenant: $($reg.user.tenantName) status=$($reg.user.tenantStatus) onboarded=$($reg.user.onboardingCompleted)"

$s = Call PUT '/onboarding/steps/1' $t @{ name = "Smoke Spa $stamp"; businessType = 'AYURVEDA'; phone = '+919811111111' }
"Step1 -> currentStep=$($s.currentStep)"
Call POST '/onboarding/steps/2/skip' $t $null | Out-Null
Call PUT '/onboarding/steps/3' $t @{ address = '1 MG Road'; taxId = '29AAAAA0000A1Z5'; timezone = 'Asia/Kolkata'; currency = 'INR'; country = 'IN' } | Out-Null
Call PUT '/onboarding/steps/4' $t @{ name = 'Smoke Main'; code = 'SMK'; openingTime = '09:00'; closingTime = '20:00'; status = 'ACTIVE'; publicBookingEnabled = $true } | Out-Null
$tpl = Call GET '/onboarding/templates/AYURVEDA' $t $null
$svcs = @($tpl.categories | ForEach-Object { $c = $_.name; $_.services | ForEach-Object { @{ name = $_.name; category = $c; durationMinutes = $_.durationMinutes; basePrice = $_.basePrice } } })
$s = Call PUT '/onboarding/steps/5' $t @{ services = $svcs }
"Step5 -> services=$($s.services.Count)"
$prices = @($s.services | ForEach-Object { @{ serviceId = $_.id; basePrice = [double]$_.basePrice + 100 } })
$s = Call PUT '/onboarding/steps/6' $t @{ tax = @{ name = 'GST 18%'; rate = 18; isInclusive = $false }; prices = $prices }
"Step6 -> taxRates=$($s.taxRates.Count) firstPrice=$($s.services[0].basePrice) tax=$($s.services[0].taxRate)"
$s = Call PUT '/onboarding/steps/7' $t @{ therapists = @(@{ name = 'Asha Kumari'; phone = '+919822222222'; specialization = 'Abhyanga' }, @{ name = 'Biju Thomas'; email = "biju$stamp@test.dev"; invite = $true }) }
"Step7 -> therapists=$($s.therapists.Count)"
Call PUT '/onboarding/steps/8' $t @{ methods = @('CASH', 'UPI'); upiId = 'smoke@upi' } | Out-Null
Call PUT '/onboarding/steps/9' $t @{ enabled = $true; phoneNumber = '+919811111111' } | Out-Null
$s = Call PUT '/onboarding/steps/10' $t @{}
"Step10 -> completed=$($s.completed)"
$me = Call GET '/auth/me' $t $null
"After go-live: tenantStatus=$($me.tenantStatus) onboarded=$($me.onboardingCompleted) branches=$($me.branches.Count)"

# Demo tenant catalogue checks
$login = Call POST '/auth/login' $null @{ identifier = 'owner@serenity.demo'; password = 'Demo@12345' }
$o = $login.tokens.accessToken
$branches = Call GET '/branches' $o $null
$kor = $branches | Where-Object code -eq 'KOR'
$ind = $branches | Where-Object code -eq 'IND'
$korSvcs = Call GET "/services?branchId=$($kor.id)&active=true" $o $null
$swedish = $korSvcs | Where-Object name -eq 'Swedish Massage'
"KOR services=$($korSvcs.Count) swedish effectivePrice=$($swedish.effectivePrice) (base $($swedish.basePrice)); hot stone offered=$([bool]($korSvcs | Where-Object name -eq 'Hot Stone Massage'))"
$ther = Call GET "/therapists?branchId=$($ind.id)" $o $null
"IND therapists: $(($ther | ForEach-Object name) -join ', ')"
$arjun = $ther | Where-Object name -eq 'Arjun Das'
$next = (Get-Date).AddDays(1)
while ($next.DayOfWeek -ne 'Monday') { $next = $next.AddDays(1) }
$d = $next.ToString('yyyy-MM-dd')
Call POST "/therapists/$($arjun.id)/exceptions" $o @{ date = $d; type = 'UNAVAILABLE'; startTime = '13:00'; endTime = '14:00'; reason = 'Training' } | Out-Null
$ex = Call GET "/therapists/$($arjun.id)/exceptions?from=$d" $o $null
"Arjun exceptions from ${d}: $($ex.Count)"

# RBAC: receptionist cannot manage services, therapist sees own profile
$rec = (Call POST '/auth/login' $null @{ identifier = 'reception@serenity.demo'; password = 'Demo@12345' }).tokens.accessToken
try { Call POST '/services' $rec @{ name = 'Hack'; durationMinutes = 30; basePrice = 1 } | Out-Null; 'RBAC FAIL' } catch { "Receptionist create service blocked: $($_.Exception.Message -replace '.*""message"":""([^""]+)"".*','$1')" }
$th = (Call POST '/auth/login' $null @{ identifier = 'arjun@serenity.demo'; password = 'Demo@12345' }).tokens.accessToken
$mine = Call GET '/therapists/me' $th $null
"Therapist me: $($mine.name) services=$($mine.services.Count) shifts=$($mine.schedules.Count)"
