# Sets up a fresh Windows machine to build Bowerbird, skipping whatever is already there.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
#
# Run outside a checkout, it clones the repository into .\bowerbird first. Then:
#   bun run build:app

param(
  [string]$Into = 'bowerbird',
  [string]$Repository = 'git@github.com:bitnimble/bowerbird.git'
)

$ErrorActionPreference = 'Stop'

$RustTargets = @('x86_64-pc-windows-msvc', 'wasm32-unknown-unknown', 'wasm32-wasip1-threads')
$LlvmBin = Join-Path $env:ProgramFiles 'LLVM\bin'
$VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$WebView2Key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

function Step([string]$message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Skip([string]$message) {
  Write-Host "    $message" -ForegroundColor DarkGray
}

function Run([string]$command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$command $($arguments -join ' ') exited with $LASTEXITCODE"
  }
}

function Has([string]$command) {
  return $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
}

# A winget install lands on PATH for new shells only.
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Winget-Install([string]$id, [string[]]$extra = @()) {
  Run 'winget' (@('install', '--id', $id, '--exact', '--accept-package-agreements', '--accept-source-agreements') + $extra)
  Refresh-Path
}

function Has-CppBuildTools {
  if (-not (Test-Path $VsWhere)) { return $false }
  $found = & $VsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return -not [string]::IsNullOrWhiteSpace($found)
}

function Checkout-Root {
  if ($PSScriptRoot -ne '') {
    $root = Split-Path $PSScriptRoot -Parent
    if (Test-Path (Join-Path $root '.git')) { return $root }
  }
  return $null
}

if (-not (Has 'winget')) {
  throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}

Step 'Git'
if (Has 'git') { Skip 'already installed' } else { Winget-Install 'Git.Git' @('--silent') }

Step 'Visual Studio Build Tools with the C++ workload'
if (Has-CppBuildTools) {
  Skip 'already installed'
} else {
  # Without the override, winget installs the Visual Studio Installer and no compiler.
  Winget-Install 'Microsoft.VisualStudio.2022.BuildTools' @(
    '--override',
    '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
  )
}

Step 'LLVM, for bindgen'
if (Test-Path (Join-Path $LlvmBin 'libclang.dll')) { Skip 'already installed' } else { Winget-Install 'LLVM.LLVM' @('--silent') }
if ($env:LIBCLANG_PATH -ne $LlvmBin) {
  [Environment]::SetEnvironmentVariable('LIBCLANG_PATH', $LlvmBin, 'User')
  $env:LIBCLANG_PATH = $LlvmBin
  Skip "LIBCLANG_PATH set to $LlvmBin"
}

Step 'WebView2 runtime'
if (Test-Path $WebView2Key) { Skip 'already installed' } else { Winget-Install 'Microsoft.EdgeWebView2Runtime' @('--silent') }

Step 'rustup'
if (Has 'rustup') { Skip 'already installed' } else { Winget-Install 'Rustlang.Rustup' @('--silent') }

$root = Checkout-Root
if ($null -eq $root) {
  Step "Cloning $Repository into $Into"
  if (Test-Path $Into) { throw "$Into already exists and is not this script's checkout." }
  Run 'git' @('clone', '--recurse-submodules', $Repository, $Into)
  $root = (Resolve-Path $Into).Path
}
Set-Location $root

Step 'Bun, at the version the repository pins'
$bunVersion = (Get-Content (Join-Path $root '.bun-version') -Raw).Trim()
$installedBun = if (Has 'bun') { (& bun --version).Trim() } else { $null }
if ($installedBun -eq $bunVersion) {
  Skip "already $bunVersion"
} else {
  # winget offers only the latest; Bun's own installer takes a version.
  $installer = Invoke-RestMethod 'https://bun.sh/install.ps1'
  & ([scriptblock]::Create($installer)) -Version $bunVersion
  Refresh-Path
}

Step 'Rust toolchain and targets'
$channel = (Select-String -Path (Join-Path $root 'rust-toolchain.toml') -Pattern 'channel\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
if ((& rustup toolchain list) -match "^$([regex]::Escape($channel))-") {
  Skip "toolchain $channel already installed"
} else {
  Run 'rustup' @('toolchain', 'install', $channel, '--profile', 'minimal', '--component', 'rustfmt')
}
$installedTargets = & rustup target list --installed --toolchain $channel
$missingTargets = @($RustTargets | Where-Object { $installedTargets -notcontains $_ })
if ($missingTargets.Count -eq 0) {
  Skip 'targets already installed'
} else {
  Run 'rustup' (@('target', 'add', '--toolchain', $channel) + $missingTargets)
}

Step 'Submodules'
Run 'git' @('submodule', 'update', '--init', '--recursive')

Step 'JavaScript dependencies'
Run 'bun' @('install', '--frozen-lockfile')
Run 'bun' @('install', '--frozen-lockfile', '--cwd', 'web')

Step 'Shader compiler, codecs, denoiser weights and print-preview maps'
Run 'bun' @('run', 'get:all')

Write-Host ''
Write-Host 'Ready. Build and install the app with:' -ForegroundColor Green
Write-Host '  bun run build:app'
Write-Host 'Open a new terminal first if anything above was installed, so PATH and LIBCLANG_PATH are current.'
