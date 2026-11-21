$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$base = 'http://localhost:4000/api/v1'
$passwordLine = Get-Content (Join-Path $repo 'apps/api/.env') | Where-Object { $_ -match '^LOCAL_DEV_PASSWORD=' }
if (-not $passwordLine) { throw 'LOCAL_DEV_PASSWORD is missing.' }
$password = ($passwordLine -split '=', 2)[1].Trim('"')

function Check($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    Write-Output "PASS: $Message"
}

$health = Invoke-RestMethod "$base/health"
Check ($health.status -eq 'ok') 'API and database health'
try {
    Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' -Body (@{ email='developer@example.test'; password='incorrect' } | ConvertTo-Json) | Out-Null
    throw 'Incorrect password was accepted.'
} catch {
    Check ($_.Exception.Response.StatusCode.value__ -eq 401) 'Incorrect password rejected'
}
$tokens = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' -Body (@{ email='developer@example.test'; password=$password } | ConvertTo-Json)
$headers = @{ Authorization = 'Bearer ' + $tokens.accessToken }
$me = Invoke-RestMethod "$base/users/me" -Headers $headers
$org = Invoke-RestMethod "$base/organizations/me" -Headers $headers
Check ($me.email -eq 'developer@example.test' -and $org.slug -eq 'local-development') 'Authenticated local workspace'
$refreshed = Invoke-RestMethod "$base/auth/refresh" -Method Post -ContentType 'application/json' -Body (@{ refreshToken=$tokens.refreshToken } | ConvertTo-Json)
Check ([bool]$refreshed.accessToken) 'Token refresh'

foreach ($endpoint in @('tools', 'departments', 'users', 'budgets', 'spend-requests', 'notifications', 'notifications/unread-count', 'audit-logs', 'billing', 'billing/month-summary', 'reports/dashboard-kpis', 'reports/period-spend?period=last_month', 'reports/period-spend-by-tool?period=this_quarter', 'reports/spend-by-category', 'reports/spend-by-department', 'reports/billing-history', 'reports/approval-sla', 'reports/forecasted-spend')) {
    Invoke-RestMethod "$base/$endpoint" -Headers $headers | Out-Null
    Write-Output "PASS: GET /$endpoint"
}

$departments = @(Invoke-RestMethod "$base/departments" -Headers $headers)
$before = Invoke-RestMethod "$base/reports/dashboard-kpis" -Headers $headers
$tool = $null
try {
    $body = @{ name=('Local smoke ' + [Guid]::NewGuid().ToString('N')); vendor='Local test'; departmentId=$departments[0].id; paymentKind='MOSUB'; monthlyAmount=19; category='DEV_TOOLS' } | ConvertTo-Json
    $tool = Invoke-RestMethod "$base/tools" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
    $after = Invoke-RestMethod "$base/reports/dashboard-kpis" -Headers $headers
    Check ([Math]::Abs($after.totalMonthlySpend - $before.totalMonthlySpend - 19) -lt 0.001) 'Created subscription contributes to dashboard spend'
    $updated = Invoke-RestMethod "$base/tools/$($tool.id)" -Method Patch -Headers $headers -ContentType 'application/json' -Body (@{ name=($tool.name + ' updated') } | ConvertTo-Json)
    Check ($updated.name.EndsWith(' updated')) 'Tool update'
    $history = Invoke-RestMethod "$base/reports/billing-history?toolId=$($tool.id)" -Headers $headers
    Check ($history.items.Count -eq 1 -and $history.items[0].amount -eq 19) 'Current subscription appears in reports'
} finally {
    if ($tool) {
        Invoke-RestMethod "$base/tools/$($tool.id)" -Method Delete -Headers $headers | Out-Null
        Write-Output 'PASS: Test tool soft-deleted'
    }
}
$afterCleanup = Invoke-RestMethod "$base/reports/dashboard-kpis" -Headers $headers
Check ($afterCleanup.toolCount -eq $before.toolCount) 'Active tool count restored'
Invoke-RestMethod "$base/auth/logout" -Method Post -Headers $headers | Out-Null
Write-Output 'PASS: Logout'
