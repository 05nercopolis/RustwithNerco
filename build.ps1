$ErrorActionPreference = "Stop"

Write-Host "[1/3] Building Rust WASM 3D mesh & normal kernel (wasm32-unknown-unknown --release)..." -ForegroundColor Cyan
cargo build --package rustwithnerco-wasm --target wasm32-unknown-unknown --release

New-Item -ItemType Directory -Force -Path "static\wasm" | Out-Null
Copy-Item "target\wasm32-unknown-unknown\release\rustwithnerco_wasm.wasm" "static\wasm\rustwithnerco_wasm.wasm" -Force

$wasmSize = (Get-Item "static\wasm\rustwithnerco_wasm.wasm").Length
Write-Host ("      WASM kernel ready: static\wasm\rustwithnerco_wasm.wasm ({0:N1} KB)" -f ($wasmSize / 1024)) -ForegroundColor Green

Write-Host "[2/3] Building Axum + Askama server..." -ForegroundColor Cyan
cargo build --package rustwithnerco-server

Write-Host "[3/3] Build complete. Run with:" -ForegroundColor Green
Write-Host "      cargo run --package rustwithnerco-server" -ForegroundColor Yellow
