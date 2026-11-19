# RustwithNerco

Digital metallurgy in real time — a dark cinema 3D WebGL studio experience powered by **Axum + Askama SSR**, a **zero-copy Rust WebAssembly 3D mesh, normal, and stress-energy kernel**, and **Three.js WebGL2** selective HDR post-processing.

## Architecture

- **Backend (`crates/server`)**: Axum 0.8, Tokio, Askama compile-time SSR templates, Brotli/Gzip response compression (`tower-http`), custom 404 fallback, and shared in-memory sculpture state (`Arc<RwLock<ActiveConfig>>`).
- **WASM 3D Mesh Kernel (`crates/wasm-sim`)**: Zero-dependency Rust `cdylib` targeting `wasm32-unknown-unknown`. Continuously morphs an `8,385`-vertex / `16,384`-triangle cyclic parametric manifold across 4 analytical 3D forms (**Monolith**, **Torus-Knot Kernel**, **Crystalline Forge**, **Horizon Ring**), recomputing smooth outward normals and a per-vertex strain-energy buffer in place inside `WebAssembly.Memory`.
- **WebGL2 Studio Stage (`static/`)**:
  - Local vendored Three.js r172 ES modules + `EffectComposer` selective `UnrealBloomPass` + energy-coupled chromatic dispersion pass.
  - Procedural `PMREMGenerator` studio cyclorama & softbox HDR lighting rig (`0 KB` external HDR downloads).
  - Authored GLSL `onBeforeCompile` micro-brushed anisotropic metal finishes (**Forged Obsidian**, **Molten Oxide**, **Liquid Mercury**, **WASM Topology**) with incandescent copper stress veins driven live by Rust WASM strain.
  - Draggable **WASM X-Ray Split Curtain** (`X`), opening **Forge Ignition** reveal, direct mesh raycast strikes, inertial drag-to-orbit inspection, and opt-in procedural **Web Audio Forge Resonance** (`M`).
  - Self-hosted `Syne`, `DM Sans`, and `JetBrains Mono` typography (`0` external runtime CDNs).

## Prerequisites

```powershell
rustup target add wasm32-unknown-unknown
```

## Build, Test & Run Locally

```powershell
cargo test --workspace
.\build.ps1
cargo run --package rustwithnerco-server
```

Open **http://127.0.0.1:3000** in your browser.

## Endpoints

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/` | Scroll-choreographed 3D WebGL digital metallurgy studio |
| `GET` | `/architecture` | System architecture specification & live Axum API inspector |
| `GET` | `/api/health` | Server uptime, request count, mesh resolution, and WASM binary metadata |
| `GET` | `/api/presets` | Surface finishes and active server configuration |
| `POST` | `/api/config` | Validate, clamp, and persist active material & kinetic parameters |
| `GET` | `/wasm/rustwithnerco_wasm.wasm` | Compiled Rust WebAssembly 3D mesh & stress kernel (`application/wasm`) |
