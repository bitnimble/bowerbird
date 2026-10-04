# Sets up a fresh Windows machine to build Bowerbird, skipping whatever is already there.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
#
# Run outside a checkout, it clones the repository into .\bowerbird first. Then, in a new
# terminal so PATH is current:
#   bun run build:app

param(
  [string]$Into = 'bowerbird',
  [string]$Repository = 'https://github.com/bitnimble/bowerbird.git'
)

$ErrorActionPreference = 'Stop'

$RustTargets = @('x86_64-pc-windows-msvc', 'wasm32-unknown-unknown', 'wasm32-wasip1-threads')
$DefaultLlvmBin = Join-Path $env:ProgramFiles 'LLVM\bin'
$VsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
$VsWhere = Join-Path $VsInstaller 'vswhere.exe'
$CppWorkload = @('--add', 'Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended', '--passive', '--norestart', '--wait')
$WebView2Keys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
# winget's "already installed" and "no newer version": detection missed it, and that's fine.
$WingetAlreadyThere = @(-1978335135, -1978335189)
$RebootLater = 3010
# The submodules' URLs are SSH, which a fresh machine has no key for.
$OverHttps = @('-c', 'url.https://github.com/.insteadOf=git@github.com:')

function Step([string]$message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Skip([string]$message) {
  Write-Host "    $message" -ForegroundColor DarkGray
}

function Run([string]$command, [string[]]$arguments, [int[]]$fine = @()) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0 -and $fine -notcontains $LASTEXITCODE) {
    throw "$command $($arguments -join ' ') exited with $LASTEXITCODE"
  }
}

function Has([string]$command) {
  return $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
}

# A winget install lands on PATH for new shells only.
function Refresh-Path {
  $known = $env:Path -split ';'
  $added = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';'
    [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
  ) | Where-Object { $_ -ne '' -and $known -notcontains $_ }
  $env:Path = (@($known) + @($added)) -join ';'
}

function Winget-Install([string]$id, [string[]]$extra = @()) {
  Run 'winget' (@('install', '--id', $id, '--exact', '--accept-package-agreements', '--accept-source-agreements') + $extra) ($WingetAlreadyThere + $RebootLater)
  Refresh-Path
}

function Has-CppBuildTools {
  if (-not (Test-Path $VsWhere)) { return $false }
  $found = & $VsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return -not [string]::IsNullOrWhiteSpace($found)
}

function Build-ToolsPath {
  if (-not (Test-Path $VsWhere)) { return $null }
  $found = & $VsWhere -products Microsoft.VisualStudio.Product.BuildTools -property installationPath
  if ([string]::IsNullOrWhiteSpace($found)) { return $null }
  return @($found)[0]
}

function Has-Libclang([string]$dir) {
  return $dir -ne '' -and (Test-Path (Join-Path $dir 'libclang.dll'))
}

function Is-Checkout([string]$dir) {
  return (Test-Path (Join-Path $dir '.git')) -and (Test-Path (Join-Path $dir 'rust-toolchain.toml'))
}

if (-not (Has 'winget')) {
  throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}

Step 'Git'
if (Has 'git') { Skip 'already installed' } else { Winget-Install 'Git.Git' @('--silent') }

Step 'Visual Studio Build Tools with the C++ workload'
$buildTools = Build-ToolsPath
if (Has-CppBuildTools) {
  Skip 'already installed'
} elseif ($null -ne $buildTools) {
  # winget leaves an installed package alone, so the workload is added to it directly.
  Run (Join-Path $VsInstaller 'setup.exe') (@('modify', '--installPath', $buildTools) + $CppWorkload) @($RebootLater)
} else {
  # Without the override, winget installs the Visual Studio Installer and no compiler.
  Winget-Install 'Microsoft.VisualStudio.2022.BuildTools' @('--override', ($CppWorkload -join ' '))
}

Step 'LLVM, for bindgen'
$llvmBin = if (Has-Libclang $env:LIBCLANG_PATH) { $env:LIBCLANG_PATH } else { $DefaultLlvmBin }
if (Has-Libclang $llvmBin) {
  Skip "already installed in $llvmBin"
} else {
  Winget-Install 'LLVM.LLVM' @('--silent')
  if (-not (Has-Libclang $llvmBin)) { throw "LLVM installed, but $llvmBin has no libclang.dll." }
}
if ($env:LIBCLANG_PATH -ne $llvmBin) {
  [Environment]::SetEnvironmentVariable('LIBCLANG_PATH', $llvmBin, 'User')
  $env:LIBCLANG_PATH = $llvmBin
  Skip "LIBCLANG_PATH set to $llvmBin"
}
# bindgen asks this clang for the system include directories; without one, libclang finds no
# stddef.h. LLVM's installer leaves it off PATH.
$clang = Join-Path $llvmBin 'clang.exe'
if ($env:CLANG_PATH -ne $clang) {
  [Environment]::SetEnvironmentVariable('CLANG_PATH', $clang, 'User')
  $env:CLANG_PATH = $clang
  Skip "CLANG_PATH set to $clang"
}

Step 'WebView2 runtime'
if (@($WebView2Keys | Where-Object { Test-Path $_ }).Count -gt 0) {
  Skip 'already installed'
} else {
  Winget-Install 'Microsoft.EdgeWebView2Runtime' @('--silent')
}

Step 'rustup'
if (Has 'rustup') {
  Skip 'already installed'
} else {
  Winget-Install 'Rustlang.Rustup' @('--silent')
  # Refresh-Path doesn't find rustup straight after its install; a second run of this did.
  $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
  $env:Path = "$(Join-Path $cargoHome 'bin');$env:Path"
  if (-not (Has 'rustup')) { throw "rustup installed, but $cargoHome\bin has no rustup.exe." }
}

$root = $null
if ($PSScriptRoot) {
  $parent = Split-Path $PSScriptRoot -Parent
  if (Is-Checkout $parent) { $root = $parent }
}
if ($null -eq $root -and (Is-Checkout $Into)) {
  $root = (Resolve-Path $Into).Path
}
if ($null -eq $root) {
  Step "Cloning $Repository into $Into"
  if (Test-Path $Into) { throw "$Into already exists and isn't a Bowerbird checkout." }
  Run 'git' (@('clone') + $OverHttps + @($Repository, $Into))
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
  $installedBun = if (Has 'bun') { (& bun --version).Trim() } else { $null }
  if ($installedBun -ne $bunVersion) {
    throw "Bun $bunVersion didn't install, or another Bun ($installedBun) comes first on PATH."
  }
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
Run 'git' ($OverHttps + @('submodule', 'update', '--init', '--recursive'))

Step 'JavaScript dependencies'
Run 'bun' @('install', '--frozen-lockfile')
Run 'bun' @('install', '--frozen-lockfile', '--cwd', 'web')

Step 'Shader compiler, codecs, denoiser weights and print-preview maps'
Run 'bun' @('run', 'get:all')

Write-Host ''
Write-Host 'Ready. Open a new terminal, so PATH and LIBCLANG_PATH are current, then build and install the app with:' -ForegroundColor Green
Write-Host '  bun run build:app'
