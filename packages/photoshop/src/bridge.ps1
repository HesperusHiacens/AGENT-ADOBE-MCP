# ps-bridge.ps1 - persistent PowerShell COM bridge for Photoshop (ASCII only; PS 5.1 reads .ps1 as ANSI).
# Protocol: one JSON request per stdin line {"id":<n>,"jsx":"<source>"}; one JSON reply per stdout line.
# Keeps a single COM connection alive so repeated calls do not re-attach Photoshop.
param(
  [string]$ProgId = "Photoshop.Application"
)

$ErrorActionPreference = "Continue"

function Send-ReplyEarly($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

# The caller passes the ProgID; refuse anything that is not a Photoshop automation
# object, so a tampered argument cannot make this bridge instantiate some other COM
# server. Kept as a pattern rather than a list so versioned ProgIDs still match.
$pattern = '^Photoshop\.[A-Za-z0-9.]+$'
if ($ProgId -notmatch $pattern) {
  Send-ReplyEarly @{ type = 'ready'; ok = $false; progid = $ProgId; error = 'PS_PROGID must start with Photoshop.' }
  exit 1
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true

function Send-Reply($obj) {
  $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
}

$t0 = Get-Date
try {
  $app = New-Object -ComObject $ProgId
  $ver = "unknown"
  try { $ver = [string]$app.Version } catch { }
  Send-Reply @{ type = 'ready'; ok = $true; progid = $ProgId; version = $ver; attachMs = [int]((Get-Date) - $t0).TotalMilliseconds }
} catch {
  Send-Reply @{ type = 'ready'; ok = $false; progid = $ProgId; error = $_.Exception.Message }
  exit 1
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  $id = 0
  $started = Get-Date
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $jsx = [string]$req.jsx
    $result = $app.DoJavaScript($jsx)
    Send-Reply @{ id = $id; ok = $true; result = $result; ms = [int]((Get-Date) - $started).TotalMilliseconds }
  } catch {
    Send-Reply @{ id = $id; ok = $false; error = $_.Exception.Message; ms = [int]((Get-Date) - $started).TotalMilliseconds }
  }
}