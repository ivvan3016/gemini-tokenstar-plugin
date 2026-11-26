[CmdletBinding()]
param(
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "==> $Description" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed ($Description) with exit code $LASTEXITCODE."
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$FrontendDir = Join-Path $RepoRoot 'frontend'
$BackendDir = Join-Path $RepoRoot 'backend'
$AppHtmlPath = Join-Path $RepoRoot 'dist\app.html'

# Prepend portable Node.js toolchain if bundled locally (avoid ExecutionPolicy issues via npm.cmd)
$PortableNodeDir = Join-Path $PSScriptRoot '..\.tools\nodejs'
if (Test-Path -LiteralPath $PortableNodeDir -PathType Container) {
    $ResolvedNodeDir = (Resolve-Path -LiteralPath $PortableNodeDir).Path
    $env:Path = "$ResolvedNodeDir$([System.IO.Path]::PathSeparator)$env:Path"
}

$TscBin = Join-Path $FrontendDir 'node_modules\.bin\tsc.cmd'
$ViteBin = Join-Path $FrontendDir 'node_modules\.bin\vite.cmd'
if (-not ((Test-Path -LiteralPath $TscBin -PathType Leaf) -and (Test-Path -LiteralPath $ViteBin -PathType Leaf))) {
    $LockFile = Join-Path $FrontendDir 'package-lock.json'
    if (Test-Path -LiteralPath $LockFile -PathType Leaf) {
        Invoke-Checked -Description 'Installing frontend dependencies (npm ci)' -Command {
            & npm.cmd --prefix $FrontendDir ci
        }
    }
    else {
        Invoke-Checked -Description 'Installing frontend dependencies (npm install)' -Command {
            & npm.cmd --prefix $FrontendDir install
        }
    }
}

if (-not $SkipTests) {
    Invoke-Checked -Description 'Frontend TypeScript check' -Command {
        & npm.cmd --prefix $FrontendDir run typecheck
    }

    Invoke-Checked -Description 'Frontend Vitest suite' -Command {
        & npm.cmd --prefix $FrontendDir run test
    }
}

Invoke-Checked -Description 'Frontend single-file production build' -Command {
    & npm.cmd --prefix $FrontendDir run build
}

Write-Host '==> Validating dist/app.html' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $AppHtmlPath -PathType Leaf)) {
    throw "Expected compiled frontend artifact not found: $AppHtmlPath"
}

$AppHtmlInfo = Get-Item -LiteralPath $AppHtmlPath
$MaxBytes = 10 * 1024 * 1024
if ($AppHtmlInfo.Length -le 0) {
    throw "dist/app.html is empty: $AppHtmlPath"
}
if ($AppHtmlInfo.Length -ge $MaxBytes) {
    throw ("dist/app.html exceeds 10 MiB limit ({0:N2} MiB): {1}" -f ($AppHtmlInfo.Length / 1MB), $AppHtmlPath)
}

$AppHtmlContent = [System.IO.File]::ReadAllText($AppHtmlPath, [System.Text.Encoding]::UTF8)
$ExternalTagPattern = '(?is)<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'']?\s*(?:https?:)?//'
if ([System.Text.RegularExpressions.Regex]::IsMatch($AppHtmlContent, $ExternalTagPattern)) {
    throw 'dist/app.html contains an external http://, https://, or protocol-relative <script> or <link> URL.'
}

$ExternalCssPattern = '(?is)(?:@import\s+(?:url\s*\(|["''])|\burl\(\s*["'']?\s*(?:https?:)?//)'
if ([System.Text.RegularExpressions.Regex]::IsMatch($AppHtmlContent, $ExternalCssPattern)) {
    throw 'dist/app.html contains an external CSS @import or url(...) network reference.'
}

$SizeKiB = [Math]::Round($AppHtmlInfo.Length / 1024.0, 2)
Write-Host ("Validated dist/app.html ({0} KiB, 0 external script/link/CSS URLs)." -f $SizeKiB) -ForegroundColor Green

if (-not $SkipTests) {
    $BackendTestsDir = Join-Path $BackendDir 'tests'
    Invoke-Checked -Description 'Backend Pytest suite' -Command {
        & uv --project $BackendDir run pytest $BackendTestsDir -v
    }
}

Write-Host 'TokenStar build and verification succeeded.' -ForegroundColor Green
