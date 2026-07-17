# build.ps1 - Windows/PowerShell build for PLOP
# Native equivalent of the Unix makefile (no rm/find/cp/make required).
# Requires: clang + wasm-ld (LLVM), uglifyjs (npm i -g uglify-js).
#
# Usage:  ./build.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# --- clean ./build ---------------------------------------------------------
if (Test-Path './build') {
    Get-ChildItem -Path './build' -File | Remove-Item -Force
} else {
    New-Item -ItemType Directory -Path './build' | Out-Null
}

# --- compile C -> wasm -----------------------------------------------------
$cFiles = Get-ChildItem -Path './src/c' -Filter '*.c' -Recurse | ForEach-Object { $_.FullName }

Write-Host "Compiling $($cFiles.Count) C files -> build/sim.wasm ..."
$clangArgs = @(
    '-O3', '-ffast-math', '-DNDEBUG', '-Wall', '-Wextra',
    '--target=wasm32', '--no-standard-libraries',
    '-Wno-unused-parameter', '-Wno-switch',
    '-Wl,--no-entry', '-Wl,--export-dynamic',
    '-o', 'build/sim.wasm'
) + $cFiles
& clang @clangArgs
if ($LASTEXITCODE -ne 0) { throw "clang failed with exit code $LASTEXITCODE" }

# --- minify + concat JS -> glue.min.js -------------------------------------
$jsFiles = @(
    './src/js/ui/primitives/vec2.js'
    './src/js/ui/primitives/point.js'
    './src/js/ui/primitives/primitive.js'
    './src/js/ui/primitives/drawable.js'
    './src/js/ui/primitives/glyphs.js'
    './src/js/ui/eventhandler.js'
    './src/js/ui/elements/element.js'
    './src/js/ui/elements/textnode.js'
    './src/js/ui/elements/button.js'
    './src/js/tools/paint.js'
    './src/js/tools/erase.js'
    './src/js/tools/line.js'
    './src/js/tools/wind.js'
    './src/js/webgpu.js'
    './src/js/glue.js'
    './src/js/elements.js'
    './src/js/lib/pako.js'
    './src/js/io.js'
)

Write-Host "Minifying JS -> build/glue.min.js ..."
$uglifyArgs = $jsFiles + @('-o', './build/glue.min.js', '--compress', '--mangle')
& uglifyjs @uglifyArgs
if ($LASTEXITCODE -ne 0) { throw "uglifyjs failed with exit code $LASTEXITCODE" }

# --- copy static assets ----------------------------------------------------
Write-Host "Copying static assets ..."
Copy-Item -Path './src/static/*' -Destination './build' -Force

Write-Host "Build complete -> ./build" -ForegroundColor Green
