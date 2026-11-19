use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Axis-aligned bounding box used for static world colliders.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Aabb {
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
}

impl Aabb {
    pub const fn new(
        min_x: f32,
        min_y: f32,
        min_z: f32,
        max_x: f32,
        max_y: f32,
        max_z: f32,
    ) -> Self {
        Self {
            min_x,
            min_y,
            min_z,
            max_x,
            max_y,
            max_z,
        }
    }

    /// Resolves sphere-vs-AABB penetration and returns `true` if a collision occurred.
    pub fn resolve_sphere(&self, x: &mut f32, y: &mut f32, z: &mut f32, radius: f32) -> bool {
        let cx = x.clamp(self.min_x, self.max_x);
        let cy = y.clamp(self.min_y, self.max_y);
        let cz = z.clamp(self.min_z, self.max_z);

        let dx = *x - cx;
        let dy = *y - cy;
        let dz = *z - cz;
        let dist_sq = dx * dx + dy * dy + dz * dz;

        if dist_sq >= radius * radius {
            return false;
        }

        if dist_sq > 1e-8 {
            let dist = dist_sq.sqrt();
            let push = radius - dist;
            let inv = 1.0 / dist;
            *x += dx * inv * push;
            *y += dy * inv * push;
            *z += dz * inv * push;
        } else {
            // Sphere center is inside the box; eject upward above the top face.
            *y = self.max_y + radius;
        }
        true
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub radius: f32,
    pub grounded: bool,
    pub colliding: bool,
    #[serde(skip)]
    phase: f32,
    #[serde(skip)]
    autonomous: bool,
}

#[wasm_bindgen]
impl Player {
    #[wasm_bindgen(constructor)]
    pub fn new(id: u32, x: f32, y: f32, z: f32) -> Self {
        Self {
            id,
            x,
            y,
            z,
            vx: 0.0,
            vy: 0.0,
            vz: 0.0,
            radius: 0.5,
            grounded: false,
            colliding: false,
            phase: (id as f32) * 1.37,
            autonomous: true,
        }
    }

    pub fn set_velocity(&mut self, vx: f32, vy: f32, vz: f32) {
        self.vx = vx;
        self.vy = vy;
        self.vz = vz;
        self.autonomous = false;
    }

    pub fn set_position(&mut self, x: f32, y: f32, z: f32) {
        self.x = x;
        self.y = y;
        self.z = z;
        self.autonomous = false;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSnapshot {
    pub tick: u64,
    pub time: f32,
    pub players: Vec<Player>,
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct World {
    players: Vec<Player>,
    obstacles: Vec<Aabb>,
    gravity: f32,
    arena_half_extent: f32,
    tick_count: u64,
    time: f32,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl World {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            players: Vec::new(),
            // Central pillar collider to exercise obstacle collision detection out of the box
            obstacles: vec![Aabb::new(-1.0, 0.0, -1.0, 1.0, 2.5, 1.0)],
            gravity: -18.0,
            arena_half_extent: 20.0,
            tick_count: 0,
            time: 0.0,
        }
    }

    pub fn add_player(&mut self, id: u32, x: f32, y: f32, z: f32) {
        if self.players.iter().any(|p| p.id == id) {
            return;
        }
        self.players.push(Player::new(id, x, y, z));
    }

    pub fn remove_player(&mut self, id: u32) -> bool {
        let before = self.players.len();
        self.players.retain(|p| p.id != id);
        self.players.len() != before
    }

    pub fn set_player_velocity(&mut self, id: u32, vx: f32, vy: f32, vz: f32) -> bool {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.set_velocity(vx, vy, vz);
            true
        } else {
            false
        }
    }

    pub fn set_player_position(&mut self, id: u32, x: f32, y: f32, z: f32) -> bool {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            p.set_position(x, y, z);
            true
        } else {
            false
        }
    }

    pub fn player_count(&self) -> usize {
        self.players.len()
    }

    pub fn tick_count(&self) -> u64 {
        self.tick_count
    }

    /// Checks whether two spheres overlap (exported for browser/WASM callers).
    pub fn check_sphere_collision(
        ax: f32,
        ay: f32,
        az: f32,
        ar: f32,
        bx: f32,
        by: f32,
        bz: f32,
        br: f32,
    ) -> bool {
        let dx = ax - bx;
        let dy = ay - by;
        let dz = az - bz;
        let min_dist = ar + br;
        dx * dx + dy * dy + dz * dz < min_dist * min_dist
    }

    /// Advances world physics, gravity, and collision resolution by `dt` seconds.
    /// Ready for both native Axum ticks and browser WebAssembly animation frames.
    pub fn tick(&mut self, dt_raw: f32) {
        let dt = dt_raw.clamp(0.0, 0.1);
        self.time += dt;
        self.tick_count += 1;

        let limit = self.arena_half_extent;

        // 1. Integrate kinematics & resolve static environment collisions
        for p in &mut self.players {
            p.colliding = false;

            if p.autonomous {
                // Smooth mock orbital patrol velocity until client drives input
                let angle = self.time * 0.9 + p.phase;
                let orbit_r = 4.0 + ((p.id % 4) as f32) * 1.4;
                let target_x = angle.cos() * orbit_r;
                let target_z = angle.sin() * orbit_r;
                p.vx = (target_x - p.x) * 3.0;
                p.vz = (target_z - p.z) * 3.0;
            } else {
                // Ground friction damping on client-controlled horizontal motion
                let damping = (-5.0 * dt).exp();
                p.vx *= damping;
                p.vz *= damping;
            }

            p.vy += self.gravity * dt;

            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;

            // Floor plane collision (y = 0)
            if p.y < p.radius {
                p.y = p.radius;
                if p.vy < 0.0 {
                    p.vy = 0.0;
                }
                p.grounded = true;
            } else {
                p.grounded = false;
            }

            // Arena perimeter walls
            let bound = limit - p.radius;
            if p.x < -bound {
                p.x = -bound;
                p.vx = p.vx.abs() * 0.5;
                p.colliding = true;
            } else if p.x > bound {
                p.x = bound;
                p.vx = -p.vx.abs() * 0.5;
                p.colliding = true;
            }

            if p.z < -bound {
                p.z = -bound;
                p.vz = p.vz.abs() * 0.5;
                p.colliding = true;
            } else if p.z > bound {
                p.z = bound;
                p.vz = -p.vz.abs() * 0.5;
                p.colliding = true;
            }

            // Static AABB obstacle collisions
            for obs in &self.obstacles {
                if obs.resolve_sphere(&mut p.x, &mut p.y, &mut p.z, p.radius) {
                    p.colliding = true;
                    if p.y >= obs.max_y + p.radius - 1e-3 && p.vy < 0.0 {
                        p.vy = 0.0;
                        p.grounded = true;
                    }
                }
            }
        }

        // 2. Pairwise player-vs-player sphere collision resolution
        self.resolve_player_collisions();
    }

    /// Serializes current world coordinates to JSON (usable from JS/WASM and Axum WS).
    pub fn snapshot_json(&self) -> String {
        serde_json::to_string(&self.snapshot()).unwrap_or_else(|_| "{}".to_string())
    }
}

impl World {
    pub fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            tick: self.tick_count,
            time: self.time,
            players: self.players.clone(),
        }
    }

    pub fn players(&self) -> &[Player] {
        &self.players
    }

    fn resolve_player_collisions(&mut self) {
        let len = self.players.len();
        for i in 0..len {
            for j in (i + 1)..len {
                let (left, right) = self.players.split_at_mut(j);
                let a = &mut left[i];
                let b = &mut right[0];

                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dz = b.z - a.z;
                let min_dist = a.radius + b.radius;
                let dist_sq = dx * dx + dy * dy + dz * dz;

                if dist_sq < min_dist * min_dist {
                    let (nx, ny, nz, overlap) = if dist_sq > 1e-8 {
                        let dist = dist_sq.sqrt();
                        (dx / dist, dy / dist, dz / dist, (min_dist - dist) * 0.5)
                    } else {
                        (1.0, 0.0, 0.0, min_dist * 0.5)
                    };

                    a.x -= nx * overlap;
                    a.y -= ny * overlap;
                    a.z -= nz * overlap;
                    b.x += nx * overlap;
                    b.y += ny * overlap;
                    b.z += nz * overlap;
                    a.colliding = true;
                    b.colliding = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_floor_and_player_sphere_collisions() {
        let mut world = World::new();
        world.add_player(1, 5.0, 0.1, 5.0);
        world.add_player(2, 5.2, 0.1, 5.0);
        world.set_player_velocity(1, 0.0, -5.0, 0.0);
        world.set_player_velocity(2, 0.0, -5.0, 0.0);

        world.tick(0.05);
        assert_eq!(world.tick_count(), 1);
        let p1 = &world.players()[0];
        let p2 = &world.players()[1];
        assert!(p1.grounded && p1.y >= p1.radius);
        assert!(p1.colliding && p2.colliding);

        let dist = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2) + (p2.z - p1.z).powi(2)).sqrt();
        assert!(dist >= p1.radius + p2.radius - 1e-3);
    }

    #[test]
    fn resolves_central_obstacle_aabb_collision() {
        let mut world = World::new();
        world.add_player(1, 1.1, 1.0, 0.0);
        world.set_player_velocity(1, -2.0, 0.0, 0.0);
        world.tick(0.05);

        let p = &world.players()[0];
        assert!(p.colliding);
        assert!(p.x >= 1.0 + p.radius - 1e-3);
    }
}
