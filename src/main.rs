use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use rustwithnerco_physics::physics::World;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

struct AppState {
    started_at: Instant,
    next_player_id: AtomicU32,
    world: Mutex<World>,
    tx: broadcast::Sender<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    uptime_secs: u64,
    connected_players: usize,
    tick: u64,
}

#[derive(Serialize)]
struct WelcomeEvent {
    #[serde(rename = "type")]
    kind: &'static str,
    player_id: u32,
}

#[derive(Serialize)]
struct BroadcastEvent {
    #[serde(rename = "type")]
    kind: &'static str,
    tick: u64,
    time: f32,
    players: Vec<rustwithnerco_physics::Player>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Move { vx: f32, vy: f32, vz: f32 },
    Position { x: f32, y: f32, z: f32 },
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let (connected_players, tick) = {
        let world = state.world.lock().expect("world lock poisoned");
        (world.player_count(), world.tick_count())
    };

    Json(HealthResponse {
        status: "ok",
        service: "rustwithnerco",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: state.started_at.elapsed().as_secs(),
        connected_players,
        tick,
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let player_id = state.next_player_id.fetch_add(1, Ordering::Relaxed);
    let spawn_angle = (player_id as f32) * 1.1;
    let spawn_x = spawn_angle.cos() * 4.5;
    let spawn_z = spawn_angle.sin() * 4.5;

    {
        let mut world = state.world.lock().expect("world lock poisoned");
        world.add_player(player_id, spawn_x, 1.5, spawn_z);
    }
    tracing::info!("Player {player_id} connected on /ws");

    let welcome = serde_json::to_string(&WelcomeEvent {
        kind: "welcome",
        player_id,
    })
    .unwrap_or_default();

    if socket.send(Message::Text(welcome.into())).await.is_err() {
        cleanup_player(&state, player_id);
        return;
    }

    let mut rx = state.tx.subscribe();

    loop {
        tokio::select! {
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(payload) => {
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(cmd) = serde_json::from_str::<ClientMessage>(&text) {
                            let mut world = state.world.lock().expect("world lock poisoned");
                            match cmd {
                                ClientMessage::Move { vx, vy, vz } => {
                                    world.set_player_velocity(player_id, vx, vy, vz);
                                }
                                ClientMessage::Position { x, y, z } => {
                                    world.set_player_position(player_id, x, y, z);
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    cleanup_player(&state, player_id);
    tracing::info!("Player {player_id} disconnected from /ws");
}

fn cleanup_player(state: &Arc<AppState>, player_id: u32) {
    let mut world = state.world.lock().expect("world lock poisoned");
    world.remove_player(player_id);
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("rustwithnerco=info,tower_http=info")),
        )
        .init();

    let (tx, _) = broadcast::channel::<String>(256);
    let state = Arc::new(AppState {
        started_at: Instant::now(),
        next_player_id: AtomicU32::new(1),
        world: Mutex::new(World::new()),
        tx,
    });

    // Authoritative 20 Hz physics tick & coordinate broadcast loop
    let tick_state = Arc::clone(&state);
    tokio::spawn(async move {
        let dt = 0.05_f32;
        let mut ticker = tokio::time::interval(Duration::from_millis(50));
        loop {
            ticker.tick().await;
            let payload = {
                let mut world = tick_state.world.lock().expect("world lock poisoned");
                if world.player_count() == 0 {
                    continue;
                }
                world.tick(dt);
                let snap = world.snapshot();
                serde_json::to_string(&BroadcastEvent {
                    kind: "coordinates",
                    tick: snap.tick,
                    time: snap.time,
                    players: snap.players,
                })
                .ok()
            };

            if let Some(json) = payload {
                let _ = tick_state.tx.send(json);
            }
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr_str = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    let addr: SocketAddr = addr_str
        .parse()
        .expect("BIND_ADDR must be a valid socket address, e.g. 0.0.0.0:3000");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    tracing::info!("RustwithNerco Axum + WS server listening on http://{addr}");
    axum::serve(listener, app)
        .await
        .expect("Axum server exited with error");
}
