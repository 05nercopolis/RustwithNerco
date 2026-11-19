use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialPreset {
    pub slug: String,
    pub name: String,
    pub summary: String,
    pub speed: f32,
    pub turbulence: f32,
    pub scale: f32,
    pub wireframe: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveConfig {
    pub material_slug: String,
    pub speed: f32,
    pub turbulence: f32,
    pub scale: f32,
    pub wireframe: bool,
}

impl ActiveConfig {
    pub fn sanitized(mut self) -> Self {
        let valid = matches!(
            self.material_slug.as_str(),
            "obsidian" | "molten-oxide" | "liquid-mercury" | "topology"
        );
        if !valid {
            self.material_slug = "obsidian".to_string();
        }
        self.speed = self.speed.clamp(0.0, 2.4);
        self.turbulence = self.turbulence.clamp(0.0, 1.8);
        self.scale = self.scale.clamp(0.7, 1.35);
        self.wireframe = self.material_slug == "topology";
        self
    }
}

pub struct AppState {
    pub started_at: Instant,
    pub request_count: AtomicU64,
    pub materials: Vec<MaterialPreset>,
    pub active: RwLock<ActiveConfig>,
    pub wasm_candidates: Vec<PathBuf>,
}

impl AppState {
    pub fn new() -> Self {
        let materials = vec![
            MaterialPreset {
                slug: "obsidian".into(),
                name: "Forged Obsidian".into(),
                summary: "Anisotropic volcanic chrome with molten copper stress veins".into(),
                speed: 1.0,
                turbulence: 0.95,
                scale: 1.0,
                wireframe: false,
            },
            MaterialPreset {
                slug: "molten-oxide".into(),
                name: "Molten Oxide".into(),
                summary: "Micro-brushed forged copper with live incandescent fracture glow".into(),
                speed: 1.1,
                turbulence: 1.15,
                scale: 1.02,
                wireframe: false,
            },
            MaterialPreset {
                slug: "liquid-mercury".into(),
                name: "Liquid Mercury".into(),
                summary: "Mirror-grade alloy reflecting studio softboxes with prismatic edges".into(),
                speed: 0.9,
                turbulence: 0.8,
                scale: 1.0,
                wireframe: false,
            },
            MaterialPreset {
                slug: "topology".into(),
                name: "WASM Topology".into(),
                summary: "Exposed 16,384-triangle lattice deformed live in Rust linear memory".into(),
                speed: 1.0,
                turbulence: 1.0,
                scale: 1.0,
                wireframe: true,
            },
        ];

        let first = &materials[0];
        let active = ActiveConfig {
            material_slug: first.slug.clone(),
            speed: first.speed,
            turbulence: first.turbulence,
            scale: first.scale,
            wireframe: first.wireframe,
        };

        Self {
            started_at: Instant::now(),
            request_count: AtomicU64::new(0),
            materials,
            active: RwLock::new(active),
            wasm_candidates: vec![
                PathBuf::from("static/wasm/rustwithnerco_wasm.wasm"),
                PathBuf::from("target/wasm32-unknown-unknown/release/rustwithnerco_wasm.wasm"),
                PathBuf::from("target/wasm32-unknown-unknown/debug/rustwithnerco_wasm.wasm"),
            ],
        }
    }

    pub fn record_request(&self) -> u64 {
        self.request_count.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn resolve_wasm_path(&self) -> Option<PathBuf> {
        self.wasm_candidates.iter().find(|p| p.exists()).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_out_of_range_and_unknown_configs() {
        let raw = ActiveConfig {
            material_slug: "unknown-slug".into(),
            speed: 99.0,
            turbulence: -4.0,
            scale: 0.1,
            wireframe: true,
        };
        let clean = raw.sanitized();
        assert_eq!(clean.material_slug, "obsidian");
        assert_eq!(clean.speed, 2.4);
        assert_eq!(clean.turbulence, 0.0);
        assert_eq!(clean.scale, 0.7);
        assert!(!clean.wireframe);
    }

    #[test]
    fn records_requests_monotonically() {
        let state = AppState::new();
        assert_eq!(state.record_request(), 1);
        assert_eq!(state.record_request(), 2);
        assert_eq!(state.materials.len(), 4);
    }
}
