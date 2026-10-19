# Install or update a checksum-verified Dictate release for the current Windows user.
[CmdletBinding()]
param(
  [string]$Version = $env:DICTATE_VERSION,
  [string]$Repository = $(if ($env:DICTATE_REPOSITORY) { $env:DICTATE_REPOSITORY } else { 'parsakhaz/experiments' }),
  [string]$FromDirectory,
  [string]$InstallDirectory = $(Join-Path $env:LOCALAPPDATA 'Programs\Dictate')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS or Linux.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository.' }
if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64') -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') { throw 'Dictate requires 64-bit Windows.' }
$useGh = $env:DICTATE_USE_GH -eq '1'
$headers = @{ 'User-Agent' = 'Dictate-Installer'; 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
# Authentication is explicit: the installer never probes or uploads ambient credentials.
if ($env:DICTATE_GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:DICTATE_GITHUB_TOKEN" }
if ($useGh -and -not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'DICTATE_USE_GH=1 requires GitHub CLI (gh).' }
if (-not $Version) {
  if ($FromDirectory) { throw '-FromDirectory requires -Version X.Y.Z.' }
  if ($useGh) {
    $Version = & gh release list --repo $Repository --limit 100 --json tagName,isPrerelease,isDraft --jq '[.[] | select(.isDraft == false and .isPrerelease == false and (.tagName | test("^dictate-v[0-9]+\\.[0-9]+\\.[0-9]+$")))][0].tagName'
    if ($LASTEXITCODE -ne 0) { throw 'Could not query releases with gh.' }
    $Version = $Version -replace '^dictate-v', ''
  } else {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $headers
    $release = $releases | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^dictate-v[0-9]+\.[0-9]+\.[0-9]+$' } | Select-Object -First 1
    if (-not $release) { throw 'No Dictate release found. Use -Version X.Y.Z, and opt in to private-repository authentication if needed.' }
    $Version = $release.tag_name -replace '^dictate-v', ''
  }
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Version must be X.Y.Z.' }
if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw '-InstallDirectory must be an absolute path.' }
$tag = "dictate-v$Version"
$assetName = "Dictate-$Version-windows-x64-setup.exe"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("dictate-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $releaseMetadata = $null
  if (-not $FromDirectory -and -not $useGh -and $env:DICTATE_GITHUB_TOKEN) {
    $releaseMetadata = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/tags/$tag" -Headers $headers
  }
  foreach ($name in @('SHA256SUMS', $assetName)) {
    $destination = Join-Path $temp $name
    if ($FromDirectory) { Copy-Item -LiteralPath (Join-Path $FromDirectory $name) -Destination $destination }
    elseif ($useGh) {
      & gh release download $tag --repo $Repository --pattern $name --dir $temp
      if ($LASTEXITCODE -ne 0) { throw "Could not download $name with gh." }
    } elseif ($releaseMetadata) {
      $asset = @($releaseMetadata.assets | Where-Object { $_.name -eq $name })
      if ($asset.Count -ne 1) { throw "Missing or duplicate release asset $name." }
      $downloadHeaders = $headers.Clone(); $downloadHeaders.Accept = 'application/octet-stream'
      Invoke-WebRequest -UseBasicParsing -Uri $asset[0].url -Headers $downloadHeaders -OutFile $destination
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repository/releases/download/$tag/$name" -OutFile $destination
    }
  }
  $lines = @(Get-Content -LiteralPath (Join-Path $temp 'SHA256SUMS') | Where-Object { $_ -match "^[a-fA-F0-9]{64}  $([regex]::Escape($assetName))$" })
  if ($lines.Count -ne 1) { throw "Missing or duplicate checksum for $assetName." }
  $expected = ($lines[0] -split '  ', 2)[0]
  $installer = Join-Path $temp $assetName
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch; the existing installation has not been changed.' }
  # NSIS requires /D= to be last and unquoted, even when the directory contains spaces.
  $result = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$InstallDirectory") -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Dictate installer failed with exit code $($result.ExitCode)." }
  $exe = Join-Path $InstallDirectory 'Dictate.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Installer did not create $exe." }
  Write-Output "Installed Dictate $Version at $exe. Launch it from the Start menu."
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
