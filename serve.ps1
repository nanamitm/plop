# serve.ps1 - Build PLOP and serve it on a local HTTP server.
#
# The build output is a static site (index.html + sim.wasm + glue.min.js).
# It must be served over HTTP; opening index.html via file:// fails because
# the browser blocks the WebAssembly fetch.
#
# Usage:
#   ./serve.ps1                # build, then serve on http://localhost:8080
#   ./serve.ps1 -Port 9000     # use a different port
#   ./serve.ps1 -NoBuild       # skip the build, just serve ./build

param(
    [int]    $Port = 8080,
    [switch] $NoBuild
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# --- build (unless skipped) ------------------------------------------------
if (-not $NoBuild) {
    Write-Host "Building ..." -ForegroundColor Cyan
    & "$PSScriptRoot/build.ps1"
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path "$PSScriptRoot/build/index.html")) {
    throw "build/index.html not found. Run ./build.ps1 first (or drop -NoBuild)."
}

# --- pick a server ---------------------------------------------------------
$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "Serving ./build at $url" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$buildDir = Join-Path $PSScriptRoot 'build'

if (Get-Command python -ErrorAction SilentlyContinue) {
    python -m http.server $Port --directory $buildDir
}
elseif (Get-Command npx -ErrorAction SilentlyContinue) {
    npx --yes serve $buildDir -l $Port
}
else {
    throw "Neither 'python' nor 'npx' is available to serve the files."
}
