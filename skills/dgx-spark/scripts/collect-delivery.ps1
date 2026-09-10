# Collect Spark model delivery onto this desk.
# Forwards loopback 8788, copies the owner bearer into a local token file,
# GETs /v1/models. Prints ids and paths only -- never the bearer.
param(
  [string]$SshTarget = $env:DGX_SPARK_SSH,
  [string]$Id = $(if ($env:DGX_SPARK_ID) { $env:DGX_SPARK_ID } else { "spark" }),
  [int]$LocalPort = $(if ($env:DGX_SPARK_LOCAL_PORT) { [int]$env:DGX_SPARK_LOCAL_PORT } else { 8788 }),
  [string]$RemoteGateway = "127.0.0.1:8788",
  [string]$RemoteToken = "~/.config/go7-inference/client-keys/owner",
  [string]$TokenFile = $env:DGX_SPARK_TOKEN_FILE,
  [string]$IdentityFile = $(Join-Path $env:USERPROFILE ".ssh\id_ed25519_spark")
)

$ErrorActionPreference = "Stop"
if (-not $SshTarget) {
  Write-Host "Set DGX_SPARK_SSH to user@host (example: go7-dgx-spark@192.168.1.205)."
  exit 2
}
if (-not $TokenFile) {
  $TokenFile = Join-Path $env:USERPROFILE ".config\go7-inference\client-keys\$Id"
}

function Restrict-File([string]$Path) {
  icacls $Path /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
}

$sshDir = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (-not (Test-Path $IdentityFile)) {
  ssh-keygen -t ed25519 -f $IdentityFile -N ([string]::Empty) -C "workhorse-dgx-spark-$Id" | Out-Host
  Write-Host "PUBLIC_KEY"
  Get-Content "$IdentityFile.pub"
  Write-Host "Install that public key on $SshTarget authorized_keys (NVIDIA Sync may use a different key), then re-run."
  exit 3
}

$sshArgs = @("-i", $IdentityFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=8")
Write-Host "SSH_TARGET=$SshTarget LOCAL_PORT=$LocalPort TOKEN_FILE=$TokenFile"

$tokenDir = Split-Path $TokenFile -Parent
New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null
$remoteSpec = "${SshTarget}:$RemoteToken"
& scp @sshArgs $remoteSpec $TokenFile
if ($LASTEXITCODE -ne 0) {
  Write-Host "SCP_FAIL=$LASTEXITCODE key login refused or remote token missing."
  exit 4
}
Restrict-File $TokenFile
$token = (Get-Content -Raw $TokenFile).Trim()
if (-not $token) {
  Write-Host "TOKEN_EMPTY"
  exit 5
}

$existing = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
  $fwd = "${LocalPort}:${RemoteGateway}"
  Start-Process -FilePath "ssh" -ArgumentList (@("-N", "-L", $fwd) + $sshArgs + @($SshTarget)) -WindowStyle Hidden
  Start-Sleep -Seconds 1
}

$ok = $false
foreach ($n in 1..8) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $LocalPort, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(500, $false) -and $c.Connected
    $c.Close()
    if ($ok) { break }
  } catch { }
  Start-Sleep -Milliseconds 250
}
if (-not $ok) {
  Write-Host "TUNNEL_DOWN port=$LocalPort"
  exit 6
}

try {
  $headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
  $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/v1/models" -Headers $headers -TimeoutSec 8
  $ids = @()
  if ($resp.data) { $ids = @($resp.data | ForEach-Object { $_.id }) }
  elseif ($resp.models) { $ids = @($resp.models | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.id } }) }
  Write-Host ("MODELS=" + ($ids -join ","))
  Write-Host ("BASE_URL=http://127.0.0.1:" + $LocalPort + "/v1")
  Write-Host ("TOKEN_FILE=" + $TokenFile)
} catch {
  Write-Host ("MODELS_UNAVAILABLE " + $_.Exception.Message)
  Write-Host ("BASE_URL=http://127.0.0.1:" + $LocalPort + "/v1")
  Write-Host ("TOKEN_FILE=" + $TokenFile)
  exit 7
}
