mod routes;
mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("rustwithnerco_server=info,tower_http=info")),
        )
        .init();

    let state = Arc::new(AppState::new());

    if let Some(wasm_path) = state.resolve_wasm_path() {
        tracing::info!("WASM mesh kernel detected at {}", wasm_path.display());
    } else {
        tracing::warn!(
            "WASM mesh kernel not found yet — run .\\build.ps1 to compile crates/wasm-sim"
        );
    }

    let app = Router::new()
        .route("/", get(routes::index_page))
        .route("/architecture", get(routes::architecture_page))
        .route("/api/health", get(routes::api_health))
        .route("/api/presets", get(routes::api_presets))
        .route("/api/config", post(routes::api_update_config))
        .route("/wasm/rustwithnerco_wasm.wasm", get(routes::serve_wasm_binary))
        .nest_service("/static", ServeDir::new("static"))
        .fallback(routes::not_found)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr_str = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let addr: SocketAddr = addr_str
        .parse()
        .expect("BIND_ADDR must be a valid socket address, e.g. 127.0.0.1:3000");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    tracing::info!("RustwithNerco server live at http://{addr}");
    axum::serve(listener, app)
        .await
        .expect("Axum server exited with error");
}
