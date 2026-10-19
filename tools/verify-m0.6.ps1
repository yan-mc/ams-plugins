# AMS 插件验证（M0.6 最小闭环 + M1 加固：Bearer/session 鉴权 + SSE）
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File tools/verify-m0.6.ps1
# 注意：必须用 PowerShell 7（pwsh）；脚本 UTF-8 无 BOM 且默认参数含中文路径，WinPS 5.1 会乱码。
param(
  [string]$NodeDir = 'C:/Users/28988/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.20.0-win-x64',
  [string]$HarnessDir = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-harness',
  [string]$GatewayDir = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-services/gateway',
  [string]$PluginsDir = 'F:/Deepseek_harness/AI音乐处理/08_项目代码/ams-plugins',
  [string]$TestHome = 'F:/Deepseek_harness/AI音乐处理/07_执行计划/_dsh_plugin_home',
  [int]$Port = 39218
)
$ErrorActionPreference = 'Continue'
$env:PATH = $NodeDir + ';' + $env:PATH
$env:CI = 'true'
$logs = Join-Path $TestHome 'logs'
New-Item -ItemType Directory -Force -Path $logs, (Join-Path $TestHome 'AMS'), (Join-Path $TestHome 'DSH_HOME') | Out-Null
$amsHome = Join-Path $TestHome 'AMS'
$dshHome = Join-Path $TestHome 'DSH_HOME'
$env:DSH_HOME = $dshHome
$env:AMS_HOME = $amsHome
$cli = Join-Path $HarnessDir 'apps/cli/lib/bin.js'
$base = 'http://127.0.0.1:' + $Port
$results = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ name = $name; pass = $ok; detail = $detail })
  Write-Output ('[{0}] {1} - {2}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
}

# 0) build/pack (idempotent; requires pnpm in PATH)
Push-Location $PluginsDir
& pnpm run pack 2>&1 | Select-Object -Last 3
Pop-Location
$tarballs = Get-ChildItem (Join-Path $PluginsDir 'dist/*.tgz') | Sort-Object LastWriteTime -Descending
$latest = @{}
foreach ($t in $tarballs) { if ($t.Name -match '^(.+)-(\d+\.\d+\.\d+)\.tgz$') { $pkg = $Matches[1]; if (-not $latest.ContainsKey($pkg)) { $latest[$pkg] = $t } } }
$installTarballs = $latest.Values | Sort-Object Name
Check 'build/pack tarballs' ($installTarballs.Count -eq 3) (($installTarballs | ForEach-Object Name) -join ', ')

# 1) Gateway
$portsPath = Join-Path $amsHome 'runtime/ports.json'
$gwProc = $null
$gatewayAlive = $false
if (Test-Path $portsPath) {
  try {
    $portsProbe = Get-Content -Raw $portsPath | ConvertFrom-Json
    $tokenProbe = (Get-Content -Raw (Join-Path $amsHome 'runtime/gateway.token')).Trim()
    $probeHeaders = @{ Authorization = 'Bearer ' + $tokenProbe }
    $null = Invoke-RestMethod ('http://127.0.0.1:' + $portsProbe.gateway.port + '/api/v1/health') -Headers $probeHeaders -TimeoutSec 5
    $gatewayAlive = $true
  } catch { $gatewayAlive = $false }
}
if (-not $gatewayAlive) {
  $gwProc = Start-Process -FilePath (Join-Path $GatewayDir '.venv/Scripts/python.exe') -ArgumentList @('-m','app','--ams-home',$amsHome,'--port','0','--log-level','INFO') -WorkingDirectory $GatewayDir -RedirectStandardOutput (Join-Path $logs 'gateway.out.log') -RedirectStandardError (Join-Path $logs 'gateway.err.log') -PassThru
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $portsPath)) { Start-Sleep -Milliseconds 500 }
}
$ports = Get-Content -Raw $portsPath | ConvertFrom-Json
$gatewayToken = (Get-Content -Raw (Join-Path $amsHome 'runtime/gateway.token')).Trim()
Check 'gateway ports.json' ((Test-Path $portsPath) -and $gatewayToken.Length -gt 16) ('port=' + $ports.gateway.port)

# 2) profile init
$profileDir = Join-Path $dshHome 'profiles/music'
if (-not (Test-Path $profileDir)) {
  Push-Location $HarnessDir
  & node $cli --profile music --from-default-profile web --dump-default-config *> (Join-Path $logs 'verify-profile-init.log')
  Pop-Location
}
Check 'profile music dir' (Test-Path $profileDir) $profileDir

# 3) store redirect inside test home
$profileWs = Join-Path $profileDir 'pnpm-workspace.yaml'
$text = Get-Content $profileWs -Raw
if ($text -notmatch 'storeDir:') {
  $nl = [Environment]::NewLine
  $text = $text.TrimEnd() + $nl + $nl + 'storeDir: ' + (Join-Path $TestHome '.pnpm-store') + $nl + 'cacheDir: ' + (Join-Path $TestHome '.pnpm-cache') + $nl
  Set-Content -Path $profileWs -Value $text -Encoding UTF8 -NoNewline
}

# 4) install plugins
Push-Location $HarnessDir
& node $cli plugin --profile music add $installTarballs.FullName *> (Join-Path $logs 'verify-plugin-add.log')
$addExit = $LASTEXITCODE
& node $cli --profile music --dump-config *> (Join-Path $logs 'verify-dump-config.log')
$dump = Get-Content (Join-Path $logs 'verify-dump-config.log') -Raw
Pop-Location
Check 'plugin add' ($addExit -eq 0) 'see logs/verify-plugin-add.log'
Check 'dump rows' (($dump -match 'ams-plugin-core') -and ($dump -match 'ams-plugin-ui')) 'rows in profile composition'

# 5) launch web
$webOut = Join-Path $logs 'verify-web.out.log'
$webErr = Join-Path $logs 'verify-web.err.log'
$web = Start-Process -FilePath 'node' -ArgumentList @($cli,'--profile','music','--no-open','--port',[string]$Port) -WorkingDirectory $HarnessDir -RedirectStandardOutput $webOut -RedirectStandardError $webErr -PassThru
$deadline = (Get-Date).AddSeconds(90); $tokenUrl = $null
while ((Get-Date) -lt $deadline) {
  $out = Get-Content $webOut -Raw -ErrorAction SilentlyContinue
  if ($out -match 'dsh web: (http://127\.0\.0\.1:' + $Port + '/\?token=\S+)') { $tokenUrl = $Matches[1]; break }
  Start-Sleep -Milliseconds 700
}
Check 'web token url' ([bool]$tokenUrl) ($(if ($tokenUrl) { 'found' } else { 'missing' }))

try {
  $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $landing = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -WebSession $webSession -TimeoutSec 15
  Check 'landing 200' ($landing.StatusCode -eq 200) ([string]$landing.StatusCode)

  # --- M1 auth checks ---
  $unauth = Invoke-WebRequest -Uri ($base + '/ams/api/summary') -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 10
  Check 'auth: no credential 401' ($unauth.StatusCode -eq 401) ('HTTP ' + $unauth.StatusCode)

  try {
    $cross = Invoke-WebRequest -Uri ($base + '/ams/api/session') -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 10 -Headers @{ Origin = 'http://evil.example'; 'Sec-Fetch-Site' = 'cross-site' }
    Check 'auth: cross-origin session 403' ($cross.StatusCode -eq 403) ('HTTP ' + $cross.StatusCode)
  } catch { Check 'auth: cross-origin session 403' $false $_.Exception.Message }

  $browserSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try {
    $issued = Invoke-WebRequest -Uri ($base + '/ams/api/session') -UseBasicParsing -SkipHttpErrorCheck -WebSession $browserSession -TimeoutSec 10 -Headers @{ Origin = $base; 'Sec-Fetch-Site' = 'same-origin' }
    $cookieCount = 0
    try { $cookieCount = $browserSession.Cookies.Count } catch { $cookieCount = 0 }
    Check 'auth: session issued' (($issued.StatusCode -eq 200) -and ($cookieCount -gt 0)) ('HTTP ' + $issued.StatusCode + ', cookies=' + $cookieCount)
  } catch { Check 'auth: session issued' $false $_.Exception.Message }

  $cookieSummary = Invoke-WebRequest -Uri ($base + '/ams/api/summary') -UseBasicParsing -SkipHttpErrorCheck -WebSession $browserSession -TimeoutSec 10
  $cookieBody = $null
  try { $cookieBody = $cookieSummary.Content | ConvertFrom-Json } catch { $cookieBody = $null }
  Check 'auth: session cookie 200' (($cookieSummary.StatusCode -eq 200) -and $cookieBody -and ($cookieBody.tools.Count -eq 5) -and ($cookieBody.auth -eq 'session')) ('HTTP ' + $cookieSummary.StatusCode + ', auth=' + $(if ($cookieBody) { $cookieBody.auth } else { '?' }))

  try {
    $bearer = Invoke-WebRequest -Uri ($base + '/ams/api/summary') -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 10 -Headers @{ Authorization = 'Bearer ' + $gatewayToken }
    $bearerBody = $null
    try { $bearerBody = $bearer.Content | ConvertFrom-Json } catch { $bearerBody = $null }
    Check 'auth: bearer 200' (($bearer.StatusCode -eq 200) -and $bearerBody -and ($bearerBody.auth -eq 'bearer')) ('HTTP ' + $bearer.StatusCode)
  } catch { Check 'auth: bearer 200' $false $_.Exception.Message }

  # --- M1 pages: tool set + Gateway job types + convert submit passthrough ---
  $toolNames = ''
  if ($cookieBody -and $cookieBody.tools) { $toolNames = ($cookieBody.tools -join ',') }
  Check 'tools: 5 registered' ($toolNames -eq 'music_ping,music_job_submit,music_job_status,music_job_list,music_job_cancel') $toolNames
  $jobTypes = @()
  if ($cookieBody -and $cookieBody.jobTypes) { $jobTypes = $cookieBody.jobTypes | ForEach-Object { $_.type } }
  Check 'job types exposed' (($jobTypes -contains 'ping') -and ($jobTypes -contains 'mock.long')) (($jobTypes -join ','))

  try {
    $convert = Invoke-WebRequest -Uri ($base + '/ams/api/jobs') -Method Post -UseBasicParsing -SkipHttpErrorCheck -WebSession $browserSession -TimeoutSec 10 -ContentType 'application/json' -Body '{"type":"convert.rvc","params":{"input_path":"F:/AMS/input/demo.wav","voice":"曼波","pitch":0}}'
    $convertBody = $null; try { $convertBody = $convert.Content | ConvertFrom-Json } catch { $convertBody = $null }
    $convertMsg = ''
    if ($convertBody -and $convertBody.error) { $convertMsg = [string]$convertBody.error.message }
    $convertJobId = ''
    if ($convertBody -and $convertBody.id) { $convertJobId = [string]$convertBody.id }
    $convertOk = $false
    if ($convert.StatusCode -eq 201) { $convertOk = $true }
    elseif ($convert.StatusCode -eq 502) {
      $convertOk = ($convertBody.error.code -eq 'AMS_GATEWAY_ERROR') -and (($convertMsg -match 'UNKNOWN_JOB_TYPE') -or ($convertMsg -match '422') -or ($convertMsg -match '未知任务类型'))
    }
    Check 'convert.rvc submit path' $convertOk ('HTTP ' + $convert.StatusCode + ', job=' + $convertJobId + ', ' + $convertMsg)
    if ($convertJobId -ne '') {
      try { $null = Invoke-WebRequest -Uri ($base + '/ams/api/jobs/' + $convertJobId + '/cancel') -Method Post -UseBasicParsing -SkipHttpErrorCheck -WebSession $browserSession -TimeoutSec 10 } catch { }
    }
  } catch { Check 'convert.rvc submit path' $false $_.Exception.Message }

  # --- M1 SSE check (independent helper, also re-checks 401/403/201/cancel) ---
  $sseOut = Join-Path $logs 'verify-sse.json'
  Push-Location $PluginsDir
  & node (Join-Path $PluginsDir 'tools/verify-sse.mjs') $base *> $sseOut
  $sseExit = $LASTEXITCODE
  Pop-Location
  $sse = Get-Content -Raw $sseOut | ConvertFrom-Json
  Check 'sse: events + cancel' ($sseExit -eq 0 -and $sse.pass -eq $true) ('events=' + $sse.sseEventCount + ', terminal=' + $sse.terminalStatus + ', cancel=' + $sse.cancelledFinalStatus + ', unauthSse=' + $sse.unauthSseStatus)

  # --- page / boot graph / client bundle ---
  $index = Invoke-WebRequest -Uri ($base + '/') -UseBasicParsing -WebSession $webSession -TimeoutSec 15
  $html = $index.Content
  Set-Content -Path (Join-Path $logs 'verify-index.html') -Value $html -Encoding UTF8
  Check 'boot graph' (($html -match '__DSH_BOOT__') -and ($html -match 'ams/plugin-ui')) 'index contains @ams/plugin-ui'
  $hrefs = [regex]::Matches($html, 'href="(plugins/[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  $ours = $hrefs | Where-Object { $_ -match 'ams/plugin-ui' } | Select-Object -First 1
  if ($ours) {
    $u = $base + '/' + ($ours -replace '&amp;','&')
    $bundle = Invoke-WebRequest -Uri $u -UseBasicParsing -WebSession $webSession -TimeoutSec 20
    Set-Content -Path (Join-Path $logs 'verify-client-combo.js') -Value $bundle.Content -Encoding UTF8
    Check 'client bundle served' ($bundle.StatusCode -eq 200 -and $bundle.Content -match 'ams/plugin-ui') ('HTTP ' + $bundle.StatusCode + ', ' + $bundle.RawContentLength + ' bytes')
    Check 'client uses SSE + session' (($bundle.Content -match 'EventSource') -and ($bundle.Content -match '/ams/api/session')) 'bundle contains EventSource and session bootstrap'
    $tabLabels = @('音源炼制', '人声分离', '变声器', '歌曲换源', 'TTS 占位')
    $tabsFound = @($tabLabels | Where-Object { $bundle.Content -match [regex]::Escape($_) })
    Check 'client feature tabs' ($tabsFound.Count -eq 5) ('tabs=' + ($tabsFound -join ','))
  } else {
    Check 'client bundle served' $false 'no combo href containing @ams/plugin-ui'
    Check 'client uses SSE + session' $false 'bundle not found'
  }

  Write-Output '--- page still loads ---'
  Check 'page load 200' ($index.StatusCode -eq 200) ('HTTP ' + $index.StatusCode)
} catch {
  Check 'http assertions' $false $_.Exception.Message
} finally {
  if ($web -and -not $web.HasExited) { Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue }
  if ($gwProc -and -not $gwProc.HasExited) { Stop-Process -Id $gwProc.Id -Force -ErrorAction SilentlyContinue }
}

$summaryResult = [pscustomobject]@{ verifiedAt = (Get-Date).ToString('o'); testHome = $TestHome; port = $Port; results = $results }
$summaryResult | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $TestHome 'M1-验证结果.json') -Encoding UTF8
$failed = @($results | Where-Object { -not $_.pass })
Write-Output ''
Write-Output ('SUMMARY: ' + ($results.Count - $failed.Count) + '/' + $results.Count + ' passed; result json: ' + (Join-Path $TestHome 'M1-验证结果.json'))
if ($failed.Count -gt 0) { exit 1 }
