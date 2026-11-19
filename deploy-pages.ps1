param(
    [string]$BasePath = "/RustwithNerco",
    [string]$ServerUrl = "http://127.0.0.1:3000"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/5] Ensuring Rust WASM kernel is freshly built..." -ForegroundColor Cyan
cargo build --package rustwithnerco-wasm --target wasm32-unknown-unknown --release
New-Item -ItemType Directory -Force -Path "static\wasm" | Out-Null
Copy-Item "target\wasm32-unknown-unknown\release\rustwithnerco_wasm.wasm" "static\wasm\rustwithnerco_wasm.wasm" -Force

$repoRoot = (Get-Location).Path
$remoteUrl = (git remote get-url origin).Trim()
$gitName = (git config user.name).Trim()
$gitEmail = (git config user.email).Trim()

$outDir = Join-Path $env:TEMP "rustwithnerco-gh-pages"
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir, "$outDir\architecture", "$outDir\api" | Out-Null

Write-Host "[2/5] Exporting rendered Askama pages & JSON snapshots from $ServerUrl..." -ForegroundColor Cyan
$indexHtml = (Invoke-WebRequest -Uri "$ServerUrl/" -UseBasicParsing).Content
$archHtml = (Invoke-WebRequest -Uri "$ServerUrl/architecture" -UseBasicParsing).Content
$healthJson = (Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing).Content
$presetsJson = (Invoke-WebRequest -Uri "$ServerUrl/api/presets" -UseBasicParsing).Content

try {
    $notFoundHtml = (Invoke-WebRequest -Uri "$ServerUrl/404-export-probe" -UseBasicParsing -SkipHttpErrorCheck).Content
} catch {
    $resp = $_.Exception.Response
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $notFoundHtml = $reader.ReadToEnd()
}

# Rewrite index.html for subpath-safe GitHub Pages static hosting
$indexStatic = $indexHtml `
    -replace '<html lang="en">', '<html lang="en" data-static="true" data-wasm-url="./static/wasm/rustwithnerco_wasm.wasm">' `
    -replace '"/static/', '"./static/' `
    -replace 'href="/"', 'href="./"' `
    -replace 'href="/architecture"', 'href="./architecture/"' `
    -replace 'href="/api/health"', 'href="./api/health.json"' `
    -replace 'Save to Axum', 'Save Preset'

# Rewrite architecture/index.html for subpath-safe static hosting
$archStatic = $archHtml `
    -replace '<html lang="en">', '<html lang="en" data-static="true">' `
    -replace '"/static/', '"../static/' `
    -replace 'href="/"', 'href="../"' `
    -replace 'href="/architecture"', 'href="./"' `
    -replace 'href="/api/health"', 'href="../api/health.json"' `
    -replace 'data-endpoint="/api/health"', 'data-endpoint="../api/health.json"' `
    -replace 'data-endpoint="/api/presets"', 'data-endpoint="../api/presets.json"' `
    -replace 'data-method="POST" data-endpoint="/api/config"', 'data-method="LOCAL" data-endpoint="../api/presets.json"' `
    -replace 'POST /api/config \(Probe\)', 'Local Config Preview'

$archStatic = $archStatic.Replace(
    'const opts = method === "POST"',
    'if (method === "LOCAL") { const saved = localStorage.getItem("rwn-config") || JSON.stringify({ material_slug: "obsidian", speed: 1.0, turbulence: 0.95, scale: 1.0, wireframe: false }); out.textContent = "// Static GitHub Pages Mode (localStorage)\n" + JSON.stringify(JSON.parse(saved), null, 2); return; } const opts = method === "POST"'
)

# Rewrite 404.html with absolute repo BasePath so it works from any broken nested URL
$notFoundStatic = $notFoundHtml `
    -replace '"/static/', "`"$BasePath/static/" `
    -replace 'href="/"', "href=`"$BasePath/`"" `
    -replace 'href="/architecture"', "href=`"$BasePath/architecture/`"" `
    -replace 'href="/api/health"', "href=`"$BasePath/api/health.json`""

[System.IO.File]::WriteAllText("$outDir\index.html", $indexStatic, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$outDir\architecture\index.html", $archStatic, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$outDir\404.html", $notFoundStatic, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$outDir\api\health.json", $healthJson, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$outDir\api\presets.json", $presetsJson, [System.Text.UTF8Encoding]::new($false))
New-Item -ItemType File -Force -Path "$outDir\.nojekyll" | Out-Null

Write-Host "[3/5] Copying static assets + compiled Rust WASM binary..." -ForegroundColor Cyan
Copy-Item -Recurse -Force "$repoRoot\static" "$outDir\static"

Write-Host "[4/5] Publishing orphan gh-pages branch to $remoteUrl..." -ForegroundColor Cyan
Push-Location $outDir
try {
    git init -b gh-pages | Out-Null
    git config user.name "$gitName"
    git config user.email "$gitEmail"
    git remote add origin "$remoteUrl"
    git add -A
    git commit -m "Deploy RustwithNerco static WASM + WebGL studio to GitHub Pages" | Out-Null
    git push -f origin gh-pages
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue
}

Write-Host "[5/5] Enabling GitHub Pages on gh-pages branch..." -ForegroundColor Cyan
$ownerRepo = (gh repo view --json nameWithOwner -q .nameWithOwner).Trim()
try {
    gh api -X POST "repos/$ownerRepo/pages" -f "source[branch]=gh-pages" -f "source[path]=/" | Out-Null
} catch {
    gh api -X PUT "repos/$ownerRepo/pages" -f "source[branch]=gh-pages" -f "source[path]=/" | Out-Null
}

$pagesInfo = gh api "repos/$ownerRepo/pages" | ConvertFrom-Json
Write-Host "GitHub Pages configured: $($pagesInfo.html_url) (status: $($pagesInfo.status))" -ForegroundColor Green
