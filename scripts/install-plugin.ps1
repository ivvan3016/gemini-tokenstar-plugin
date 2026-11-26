[CmdletBinding()]
param(
    [string]$TargetDir = (Join-Path $HOME '.gemini\config\plugins\tokenstar'),
    [switch]$SkipBuild,
    [switch]$SkipSync,
    [switch]$Verify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Copy-DirectoryFiltered {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestinationDir,
        [string[]]$ExcludedDirNames = @('__pycache__', '.venv', '.pytest_cache', 'tests'),
        [string[]]$ExcludedFilePatterns = @('*.pyc', '*.pyo')
    )

    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null

    foreach ($Entry in Get-ChildItem -LiteralPath $SourceDir -Force) {
        if ($Entry.PSIsContainer) {
            if ($ExcludedDirNames -contains $Entry.Name) {
                continue
            }
            $ChildDest = Join-Path $DestinationDir $Entry.Name
            Copy-DirectoryFiltered `
                -SourceDir $Entry.FullName `
                -DestinationDir $ChildDest `
                -ExcludedDirNames $ExcludedDirNames `
                -ExcludedFilePatterns $ExcludedFilePatterns
        }
        else {
            $SkipFile = $false
            foreach ($Pattern in $ExcludedFilePatterns) {
                if ($Entry.Name -like $Pattern) {
                    $SkipFile = $true
                    break
                }
            }
            if (-not $SkipFile) {
                Copy-Item -LiteralPath $Entry.FullName -Destination (Join-Path $DestinationDir $Entry.Name) -Force
            }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    throw 'TargetDir cannot be empty.'
}

$ResolvedTargetDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($TargetDir)
$RootDrive = [System.IO.Path]::GetPathRoot($ResolvedTargetDir)
if ($ResolvedTargetDir.TrimEnd('\', '/') -eq $RootDrive.TrimEnd('\', '/')) {
    throw "Refusing to install directly into filesystem root: $ResolvedTargetDir"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $SkipBuild) {
    $BuildScript = Join-Path $PSScriptRoot 'build.ps1'
    if ($Verify) {
        & $BuildScript
    }
    else {
        & $BuildScript -SkipTests
    }
}

$PluginManifestSrc = Join-Path $RepoRoot 'plugin\plugin.json'
$McpConfigSrc = Join-Path $RepoRoot 'plugin\mcp_config.json'
$AssetsSrcDir = Join-Path $RepoRoot 'plugin\assets'
$AppHtmlSrc = Join-Path $RepoRoot 'dist\app.html'
$PyprojectSrc = Join-Path $RepoRoot 'backend\pyproject.toml'
$UvLockSrc = Join-Path $RepoRoot 'backend\uv.lock'
$BackendSrcDir = Join-Path $RepoRoot 'backend\src'

foreach ($RequiredPath in @(
        $PluginManifestSrc,
        $McpConfigSrc,
        $AssetsSrcDir,
        $AppHtmlSrc,
        $PyprojectSrc,
        $UvLockSrc,
        $BackendSrcDir
    )) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "Required plugin build input missing: $RequiredPath"
    }
}

Write-Host "==> Staging TokenStar plugin into $ResolvedTargetDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $ResolvedTargetDir -Force | Out-Null

# Clean only TokenStar-managed bundle entries inside TargetDir before copying (preserve server\.venv)
foreach ($ManagedEntry in @('plugin.json', 'mcp_config.json', 'assets', 'dist', 'server\pyproject.toml', 'server\uv.lock', 'server\src')) {
    $ManagedPath = Join-Path $ResolvedTargetDir $ManagedEntry
    if (Test-Path -LiteralPath $ManagedPath) {
        Remove-Item -LiteralPath $ManagedPath -Recurse -Force
    }
}

$TargetAssetsDir = Join-Path $ResolvedTargetDir 'assets'
$TargetDistDir = Join-Path $ResolvedTargetDir 'dist'
$TargetServerDir = Join-Path $ResolvedTargetDir 'server'
$TargetServerSrcDir = Join-Path $TargetServerDir 'src'

New-Item -ItemType Directory -Path $TargetDistDir -Force | Out-Null
New-Item -ItemType Directory -Path $TargetServerDir -Force | Out-Null

Copy-Item -LiteralPath $PluginManifestSrc -Destination (Join-Path $ResolvedTargetDir 'plugin.json') -Force
Copy-Item -LiteralPath $McpConfigSrc -Destination (Join-Path $ResolvedTargetDir 'mcp_config.json') -Force
Copy-DirectoryFiltered -SourceDir $AssetsSrcDir -DestinationDir $TargetAssetsDir
Copy-Item -LiteralPath $AppHtmlSrc -Destination (Join-Path $TargetDistDir 'app.html') -Force
Copy-Item -LiteralPath $PyprojectSrc -Destination (Join-Path $TargetServerDir 'pyproject.toml') -Force
Copy-Item -LiteralPath $UvLockSrc -Destination (Join-Path $TargetServerDir 'uv.lock') -Force
Copy-DirectoryFiltered -SourceDir $BackendSrcDir -DestinationDir $TargetServerSrcDir

if (-not $SkipSync) {
    Write-Host "==> Syncing isolated Python environment in $TargetServerDir" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & uv --project $TargetServerDir sync --no-dev
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'uv sync --no-dev failed; retrying with --offline using local uv cache.'
        $global:LASTEXITCODE = 0
        & uv --project $TargetServerDir sync --no-dev --offline
        if ($LASTEXITCODE -ne 0) {
            throw "uv sync --no-dev failed (and --offline fallback failed) in $TargetServerDir. For offline CI without a uv cache, re-run with -SkipSync."
        }
    }
}
else {
    Write-Host '==> Skipping uv sync (-SkipSync specified).' -ForegroundColor Yellow
}

Write-Host "TokenStar plugin staged cleanly at: $ResolvedTargetDir" -ForegroundColor Green
