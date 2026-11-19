use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::state::{ActiveConfig, AppState, MaterialPreset};

pub struct HtmlTemplate<T>(pub T);

impl<T: Template> IntoResponse for HtmlTemplate<T> {
    fn into_response(self) -> Response {
        match self.0.render() {
            Ok(html) => Html(html).into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Template render error: {err}"),
            )
                .into_response(),
        }
    }
}

#[derive(Template)]
#[template(path = "index.html")]
pub struct IndexTemplate {
    pub title: String,
    pub active_nav: &'static str,
    pub version: &'static str,
    pub wasm_ready: bool,
    pub wasm_kb: String,
    pub materials: Vec<MaterialPreset>,
    pub initial_config_json: String,
}

#[derive(Template)]
#[template(path = "architecture.html")]
pub struct ArchitectureTemplate {
    pub title: String,
    pub active_nav: &'static str,
    pub version: &'static str,
    pub wasm_ready: bool,
    pub wasm_kb: String,
    pub requests_served: u64,
    pub materials: Vec<MaterialPreset>,
}

#[derive(Template)]
#[template(path = "not_found.html")]
pub struct NotFoundTemplate {
    pub active_nav: &'static str,
    pub version: &'static str,
    pub wasm_ready: bool,
    pub wasm_kb: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub project: &'static str,
    pub version: &'static str,
    pub uptime_secs: u64,
    pub requests_served: u64,
    pub wasm_ready: bool,
    pub wasm_size_bytes: u64,
    pub mesh_vertices: u32,
    pub mesh_triangles: u32,
    pub stack: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct PresetsResponse {
    pub materials: Vec<MaterialPreset>,
    pub active: ActiveConfig,
}

fn wasm_stats(state: &AppState) -> (bool, u64, String) {
    if let Some(path) = state.resolve_wasm_path() {
        if let Ok(meta) = std::fs::metadata(path) {
            let bytes = meta.len();
            return (true, bytes, format!("{:.1} KB", (bytes as f64) / 1024.0));
        }
    }
    (false, 0, "unbuilt".into())
}

pub async fn index_page(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    state.record_request();
    let (wasm_ready, _, wasm_kb) = wasm_stats(&state);
    let active = state.active.read().expect("config lock poisoned").clone();
    let initial_config_json =
        serde_json::to_string(&active).unwrap_or_else(|_| "{}".to_string());

    HtmlTemplate(IndexTemplate {
        title: "RustwithNerco — Sculpted Rust WASM & WebGL Studio".into(),
        active_nav: "home",
        version: env!("CARGO_PKG_VERSION"),
        wasm_ready,
        wasm_kb,
        materials: state.materials.clone(),
        initial_config_json,
    })
}

pub async fn architecture_page(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let reqs = state.record_request();
    let (wasm_ready, _, wasm_kb) = wasm_stats(&state);

    HtmlTemplate(ArchitectureTemplate {
        title: "Architecture — RustwithNerco".into(),
        active_nav: "arch",
        version: env!("CARGO_PKG_VERSION"),
        wasm_ready,
        wasm_kb,
        requests_served: reqs,
        materials: state.materials.clone(),
    })
}

pub async fn not_found(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    state.record_request();
    let (wasm_ready, _, wasm_kb) = wasm_stats(&state);
    (
        StatusCode::NOT_FOUND,
        HtmlTemplate(NotFoundTemplate {
            active_nav: "none",
            version: env!("CARGO_PKG_VERSION"),
            wasm_ready,
            wasm_kb,
        }),
    )
}

pub async fn api_health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let reqs = state.record_request();
    let (wasm_ready, wasm_size_bytes, _) = wasm_stats(&state);

    Json(HealthResponse {
        status: "ok",
        project: "RustwithNerco",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: state.started_at.elapsed().as_secs(),
        requests_served: reqs,
        wasm_ready,
        wasm_size_bytes,
        mesh_vertices: 8_385,
        mesh_triangles: 16_384,
        stack: vec![
            "Rust 2021 Workspace",
            "Axum 0.8 + Tokio",
            "Askama SSR Templates",
            "Zero-Copy Rust WASM 3D Mesh Morph & Normal Kernel",
            "Three.js WebGL2 PBR + Procedural Studio HDR Softbox Rig",
        ],
    })
}

pub async fn api_presets(State(state): State<Arc<AppState>>) -> Json<PresetsResponse> {
    state.record_request();
    let active = state.active.read().expect("config lock poisoned").clone();
    Json(PresetsResponse {
        materials: state.materials.clone(),
        active,
    })
}

pub async fn api_update_config(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ActiveConfig>,
) -> Json<ActiveConfig> {
    state.record_request();
    let clean = payload.sanitized();
    let mut guard = state.active.write().expect("config lock poisoned");
    *guard = clean.clone();
    Json(clean)
}

pub async fn serve_wasm_binary(State(state): State<Arc<AppState>>) -> Response {
    state.record_request();
    let Some(path) = state.resolve_wasm_path() else {
        return (
            StatusCode::NOT_FOUND,
            "WASM binary not found. Run .\\build.ps1",
        )
            .into_response();
    };

    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/wasm"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read WASM binary: {err}"),
        )
            .into_response(),
    }
}
