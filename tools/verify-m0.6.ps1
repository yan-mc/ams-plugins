# AMS M0.6 一键验证（隔离 DSH_HOME + Gateway + 插件安装 + 启动 + 断言）
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
Check 'gateway ports.json' (Test-Path $portsPath) $portsPath

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
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $landing = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -WebSession $session -TimeoutSec 15
  Check 'landing 200' ($landing.StatusCode -eq 200) ([string]$landing.StatusCode)
  $summary = Invoke-RestMethod ('http://127.0.0.1:{0}/ams/api/summary' -f $Port) -TimeoutSec 10
  $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $logs 'verify-summary.json') -Encoding UTF8
  Check 'host tools' (($summary.tools -join ',') -eq 'music_ping,music_job_submit,music_job_status') ($summary.tools -join ',')
  Check 'gateway bridge' ([bool]$summary.gateway.ok) ('gateway version ' + $summary.gateway.version)
  $job = Invoke-RestMethod ('http://127.0.0.1:{0}/ams/api/jobs' -f $Port) -Method Post -ContentType 'application/json' -Body '{"type":"ping","params":{}}' -TimeoutSec 10
  $final = $null
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $s = Invoke-RestMethod ('http://127.0.0.1:{0}/ams/api/summary' -f $Port) -TimeoutSec 5
    $found = @($s.jobs | Where-Object { $_.id -eq $job.id }) | Select-Object -First 1
    if ($found) { $final = $found; if (@('succeeded','failed','cancelled') -contains $found.status) { break } }
  }
  if ($final) { $final | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $logs 'verify-final-job.json') -Encoding UTF8 }
  Check 'job round trip' ($final -and $final.status -eq 'succeeded') ($(if ($final) { $final.id + ' ' + $final.status } else { 'not found' }))
  $index = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/' -f $Port) -UseBasicParsing -WebSession $session -TimeoutSec 15
  $html = $index.Content
  Set-Content -Path (Join-Path $logs 'verify-index.html') -Value $html -Encoding UTF8
  Check 'boot graph' (($html -match '__DSH_BOOT__') -and ($html -match 'ams/plugin-ui')) 'index contains @ams/plugin-ui'
  $hrefs = [regex]::Matches($html, 'href="(plugins/[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  $ours = $hrefs | Where-Object { $_ -match 'ams/plugin-ui' } | Select-Object -First 1
  if ($ours) {
    $u = ('http://127.0.0.1:{0}/' -f $Port) + ($ours -replace '&amp;','&')
    $b = Invoke-WebRequest -Uri $u -UseBasicParsing -WebSession $session -TimeoutSec 20
    Set-Content -Path (Join-Path $logs 'verify-client-combo.js') -Value $b.Content -Encoding UTF8
    Check 'client bundle' ($b.StatusCode -eq 200 -and $b.Content -match 'ams/plugin-ui') ('HTTP ' + $b.StatusCode + ', ' + $b.RawContentLength + ' bytes')
  } else { Check 'client bundle' $false 'no combo href containing @ams/plugin-ui' }
} catch {
  Check 'http assertions' $false $_.Exception.Message
} finally {
  if ($web -and -not $web.HasExited) { Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue }
  if ($gwProc -and -not $gwProc.HasExited) { Stop-Process -Id $gwProc.Id -Force -ErrorAction SilentlyContinue }
}

$summaryResult = [pscustomobject]@{ verifiedAt = (Get-Date).ToString('o'); testHome = $TestHome; results = $results }
$summaryResult | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $TestHome 'M0.6-验证结果.json') -Encoding UTF8
$failed = @($results | Where-Object { -not $_.pass })
Write-Output ''
Write-Output ('SUMMARY: ' + ($results.Count - $failed.Count) + '/' + $results.Count + ' passed; result json: ' + (Join-Path $TestHome 'M0.6-验证结果.json'))
if ($failed.Count -gt 0) { exit 1 }
