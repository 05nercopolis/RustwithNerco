use std::cell::RefCell;
use std::f32::consts::{PI, TAU};

const U_SEGS: usize = 128;
const V_SEGS: usize = 64;
const COLS: usize = U_SEGS + 1;
const ROWS: usize = V_SEGS + 1;
const VERT_COUNT: usize = COLS * ROWS;
const INDEX_COUNT: usize = U_SEGS * V_SEGS * 6;

#[inline]
fn smoothstep(t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[inline]
fn v_add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
fn v_sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn v_scale(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
fn v_dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn v_cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn v_norm(a: [f32; 3]) -> [f32; 3] {
    let len = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if len > 1e-6 {
        let inv = 1.0 / len;
        [a[0] * inv, a[1] * inv, a[2] * inv]
    } else {
        [0.0, 1.0, 0.0]
    }
}

#[inline]
fn v_lerp(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

#[inline]
fn knot_spine(u: f32, t: f32) -> [f32; 3] {
    let a = u * TAU;
    let breath = 0.08 * (a * 3.0 - t * 0.9).sin();
    let r = 1.92 + (0.68 + breath) * (3.0 * a).cos();
    [
        r * (2.0 * a).cos(),
        0.92 * (3.0 * a).sin(),
        r * (2.0 * a).sin(),
    ]
}

/// Sculpture 0: Forged Ferrofluid Monolith (returns position + harmonic ridge stress)
#[inline]
fn eval_ferrofluid(u: f32, v: f32, t: f32, turb: f32) -> ([f32; 3], f32) {
    let theta = u * TAU;
    let phi = v * PI;
    let sp = phi.sin();
    let cp = phi.cos();
    let nx = sp * theta.cos();
    let ny = cp;
    let nz = sp * theta.sin();

    let w1 = (nx * 3.4 + t * 0.85).sin() * (ny * 3.4 - t * 0.72).cos() * (nz * 3.4 + t * 0.65).sin();
    let w2 = (ny * 6.2 + nz * 4.8 - t * 1.15).sin() * (nx * 5.2 + t * 0.92).cos();
    let w3 = ((nx * nz - ny * ny) * 7.8 + t * 1.45).sin();

    let disp = turb * (0.46 * w1 + 0.21 * w2 + 0.11 * w3);
    let r = 2.18 + disp;
    let stress = (disp.abs() * 1.15 + w3.abs() * 0.25 * turb).clamp(0.0, 1.0);
    ([nx * r, ny * r, nz * r], stress)
}

/// Sculpture 1: Sculpted Twisted (2,3) Torus-Knot Manifold
#[inline]
fn eval_torus_knot(u: f32, v: f32, t: f32, turb: f32) -> ([f32; 3], f32) {
    let eps = 1.0 / 512.0;
    let c = knot_spine(u, t);
    let c_prev = knot_spine(u - eps, t);
    let c_next = knot_spine(u + eps, t);
    let tangent = v_norm(v_sub(c_next, c_prev));

    let proj = v_dot(c, tangent);
    let normal = v_norm(v_sub(c, v_scale(tangent, proj)));
    let binormal = v_cross(tangent, normal);

    let tube_ang = v * TAU;
    let flute = 0.13 * turb * (tube_ang * 5.0 + u * TAU * 4.0 - t * 1.6).sin();
    let rad = 0.56 + flute + 0.06 * (u * TAU * 6.0 + t).cos();

    let ca = tube_ang.cos();
    let sa = tube_ang.sin();
    let offset = v_sub(v_scale(normal, ca * rad), v_scale(binormal, sa * rad));
    let stress = (flute.abs() * 4.2).clamp(0.0, 1.0);
    (v_add(c, offset), stress)
}

/// Sculpture 2: Crystalline Fluted Harmonic Core
#[inline]
fn eval_crystalline(u: f32, v: f32, t: f32, turb: f32) -> ([f32; 3], f32) {
    let theta = u * TAU;
    let phi = v * PI;
    let sp = phi.sin();
    let cp = phi.cos();

    let ridge_a = (6.0 * theta + t * 0.55).sin() * (5.0 * phi - t * 0.45).sin();
    let ridge_b = (12.0 * theta - t * 0.95).cos() * (sp * sp);
    let ridge_c = (4.0 * phi + 3.0 * theta + t * 0.7).sin();

    let disp = turb * (0.43 * ridge_a + 0.17 * ridge_b + 0.14 * ridge_c);
    let r = 2.02 + disp;
    let stress = (disp.abs() * 1.35).clamp(0.0, 1.0);
    ([sp * theta.cos() * r, cp * r, sp * theta.sin() * r], stress)
}

/// Sculpture 3: Monumental Fluted Horizon Singularity Ring
#[inline]
fn eval_horizon_torus(u: f32, v: f32, t: f32, turb: f32) -> ([f32; 3], f32) {
    let theta = u * TAU;
    let a = v * TAU;
    let ct = theta.cos();
    let st = theta.sin();

    let major = 2.42 + 0.14 * turb * (theta * 3.0 - t * 0.75).cos();
    let flute = 0.15 * turb * (a * 6.0 - theta * 3.0 + t * 1.2).sin();
    let minor = 0.66 + flute;

    let radial = major + minor * a.cos();
    let y = -minor * a.sin() + 0.15 * turb * (theta * 2.0 + t * 0.6).sin();
    let stress = (flute.abs() * 3.8).clamp(0.0, 1.0);
    ([radial * ct, y, radial * st], stress)
}

struct PulseWave {
    origin: [f32; 3],
    age: f32,
    strength: f32,
    active: bool,
}

pub struct MeshEngine {
    time: f32,
    speed: f32,
    turbulence: f32,
    scale: f32,
    energy: f32,

    pointer: [f32; 3],
    pointer_target: [f32; 3],
    pointer_weight: f32,
    pointer_active: bool,

    pulse: PulseWave,

    positions: Vec<f32>,
    normals: Vec<f32>,
    energies: Vec<f32>,
    indices: Vec<u32>,
}

impl MeshEngine {
    pub fn new() -> Self {
        Self {
            time: 0.0,
            speed: 1.0,
            turbulence: 0.95,
            scale: 1.0,
            energy: 0.0,
            pointer: [0.0; 3],
            pointer_target: [0.0; 3],
            pointer_weight: 0.0,
            pointer_active: false,
            pulse: PulseWave {
                origin: [0.0; 3],
                age: 0.0,
                strength: 0.0,
                active: false,
            },
            positions: Vec::new(),
            normals: Vec::new(),
            energies: Vec::new(),
            indices: Vec::new(),
        }
    }

    pub fn init(&mut self) -> u32 {
        self.positions.resize(VERT_COUNT * 3, 0.0);
        self.normals.resize(VERT_COUNT * 3, 0.0);
        self.energies.resize(VERT_COUNT, 0.0);
        self.indices.clear();
        self.indices.reserve(INDEX_COUNT);

        for row in 0..V_SEGS {
            for col in 0..U_SEGS {
                let i00 = (row * COLS + col) as u32;
                let i10 = i00 + 1;
                let i01 = ((row + 1) * COLS + col) as u32;
                let i11 = i01 + 1;

                self.indices.push(i00);
                self.indices.push(i10);
                self.indices.push(i01);

                self.indices.push(i10);
                self.indices.push(i11);
                self.indices.push(i01);
            }
        }

        self.step(0.016, 0.0);
        VERT_COUNT as u32
    }

    pub fn trigger_pulse(&mut self, x: f32, y: f32, z: f32, strength: f32) {
        self.pulse = PulseWave {
            origin: [x, y, z],
            age: 0.0,
            strength: strength.clamp(0.1, 2.5),
            active: true,
        };
    }

    fn compute_normals(&mut self, cyclic_v: bool) {
        for row in 0..ROWS {
            let r_wrap = if cyclic_v && row == V_SEGS { 0 } else { row };
            let r_prev = if cyclic_v {
                if r_wrap == 0 { V_SEGS - 1 } else { r_wrap - 1 }
            } else if row == 0 {
                0
            } else {
                row - 1
            };
            let r_next = if cyclic_v {
                if r_wrap == V_SEGS - 1 { 0 } else { r_wrap + 1 }
            } else if row == V_SEGS {
                V_SEGS
            } else {
                row + 1
            };

            for col in 0..COLS {
                let c_wrap = if col == U_SEGS { 0 } else { col };
                let c_prev = if c_wrap == 0 { U_SEGS - 1 } else { c_wrap - 1 };
                let c_next = if c_wrap == U_SEGS - 1 { 0 } else { c_wrap + 1 };

                let i_l = (r_wrap * COLS + c_prev) * 3;
                let i_r = (r_wrap * COLS + c_next) * 3;
                let i_u = (r_prev * COLS + c_wrap) * 3;
                let i_d = (r_next * COLS + c_wrap) * 3;

                let du = [
                    self.positions[i_r] - self.positions[i_l],
                    self.positions[i_r + 1] - self.positions[i_l + 1],
                    self.positions[i_r + 2] - self.positions[i_l + 2],
                ];
                let dv = [
                    self.positions[i_d] - self.positions[i_u],
                    self.positions[i_d + 1] - self.positions[i_u + 1],
                    self.positions[i_d + 2] - self.positions[i_u + 2],
                ];

                let mut n = v_cross(du, dv);
                let n_len_sq = v_dot(n, n);

                if !cyclic_v && (row == 0 || row == V_SEGS || n_len_sq < 1e-7) {
                    // True spherical pole normal from neighboring ring
                    let ring_row = if row == 0 { 1 } else if row == V_SEGS { V_SEGS - 1 } else { row };
                    let cur = (row * COLS + col) * 3;
                    let rad = [
                        self.positions[cur],
                        self.positions[cur + 1],
                        self.positions[cur + 2],
                    ];
                    if row == 0 || row == V_SEGS {
                        let i_a = (ring_row * COLS + 0) * 3;
                        let i_b = (ring_row * COLS + (U_SEGS / 4)) * 3;
                        let i_c = (ring_row * COLS + (U_SEGS / 2)) * 3;
                        let pa = [self.positions[i_a], self.positions[i_a + 1], self.positions[i_a + 2]];
                        let pb = [self.positions[i_b], self.positions[i_b + 1], self.positions[i_b + 2]];
                        let pc = [self.positions[i_c], self.positions[i_c + 1], self.positions[i_c + 2]];
                        let plane_n = v_cross(v_sub(pb, pa), v_sub(pc, pa));
                        if v_dot(plane_n, plane_n) > 1e-9 {
                            let aligned = if v_dot(plane_n, rad) < 0.0 {
                                v_scale(plane_n, -1.0)
                            } else {
                                plane_n
                            };
                            n = v_norm(aligned);
                        } else {
                            n = v_norm(rad);
                        }
                    } else {
                        n = v_norm(rad);
                    }
                } else if n_len_sq > 1e-10 {
                    n = v_norm(n);
                } else {
                    let cur = (row * COLS + col) * 3;
                    n = v_norm([
                        self.positions[cur],
                        self.positions[cur + 1],
                        self.positions[cur + 2],
                    ]);
                }

                let out = (row * COLS + col) * 3;
                self.normals[out] = n[0];
                self.normals[out + 1] = n[1];
                self.normals[out + 2] = n[2];
            }
        }
    }

    pub fn step(&mut self, dt_raw: f32, morph_raw: f32) {
        let dt = dt_raw.clamp(0.0, 0.045);
        let speed = self.speed.clamp(0.0, 2.4);
        self.time += dt * speed;
        let t = self.time;
        let turb = self.turbulence.clamp(0.0, 1.8);
        let scale = self.scale.clamp(0.7, 1.35);

        // Smooth pointer inertia
        let target_w = if self.pointer_active { 1.0 } else { 0.0 };
        let lerp_p = (dt * 8.5).min(1.0);
        self.pointer_weight += (target_w - self.pointer_weight) * lerp_p;
        self.pointer = v_lerp(self.pointer, self.pointer_target, (dt * 12.0).min(1.0));

        // Advance shockwave ring
        if self.pulse.active {
            self.pulse.age += dt;
            if self.pulse.age > 2.8 {
                self.pulse.active = false;
            }
        }

        let morph = morph_raw.clamp(0.0, 3.0);
        let seg = (morph.floor() as u32).min(2);
        let blend = smoothstep(morph - (seg as f32));
        // Cyclic-V seam applies cleanly when dominant sculpture is toroidal (1 or 3)
        let cyclic_v = match seg {
            0 => blend > 0.5,
            1 => blend <= 0.5,
            _ => blend > 0.5,
        };
        // Extra molten ridge shimmer while actively transitioning between sculptures
        let morph_strain = (blend * (1.0 - blend) * 4.0) * 0.48;

        let inv_u = 1.0 / (U_SEGS as f32);
        let inv_v = 1.0 / (V_SEGS as f32);

        // Pass 1: Evaluate base morphed parametric geometry & curvature stress
        for row in 0..ROWS {
            let v = if cyclic_v && row == V_SEGS {
                0.0
            } else {
                (row as f32) * inv_v
            };
            for col in 0..COLS {
                let u = if col == U_SEGS {
                    0.0
                } else {
                    (col as f32) * inv_u
                };

                let (p, base_stress) = match seg {
                    0 => {
                        let (a, sa) = eval_ferrofluid(u, v, t, turb);
                        if blend > 1e-4 {
                            let (b, sb) = eval_torus_knot(u, v, t, turb);
                            (v_lerp(a, b, blend), sa + (sb - sa) * blend)
                        } else {
                            (a, sa)
                        }
                    }
                    1 => {
                        let (a, sa) = eval_torus_knot(u, v, t, turb);
                        if blend > 1e-4 {
                            let (b, sb) = eval_crystalline(u, v, t, turb);
                            (v_lerp(a, b, blend), sa + (sb - sa) * blend)
                        } else {
                            (a, sa)
                        }
                    }
                    _ => {
                        let (a, sa) = eval_crystalline(u, v, t, turb);
                        if blend > 1e-4 {
                            let (b, sb) = eval_horizon_torus(u, v, t, turb);
                            (v_lerp(a, b, blend), sa + (sb - sa) * blend)
                        } else {
                            (a, sa)
                        }
                    }
                };

                let v_idx = row * COLS + col;
                let idx = v_idx * 3;
                self.positions[idx] = p[0] * scale;
                self.positions[idx + 1] = p[1] * scale;
                self.positions[idx + 2] = p[2] * scale;
                self.energies[v_idx] = (base_stress * 0.32 + morph_strain * base_stress).clamp(0.0, 1.0);
            }
        }

        // Compute base surface normals so tactile dents & waves displace cleanly along true surface normals
        self.compute_normals(cyclic_v);

        let ptr = self.pointer;
        let ptr_w = self.pointer_weight;
        let pulse_active = self.pulse.active;
        let pulse_origin = self.pulse.origin;
        let pulse_age = self.pulse.age;
        let pulse_amp = self.pulse.strength * (-pulse_age * 1.4).exp();
        let pulse_front = pulse_age * 4.6;
        let has_interactive = ptr_w > 0.005 || (pulse_active && pulse_amp > 0.005);

        let mut energy_accum = 0.0_f32;

        // Pass 2: Apply normal-aligned cursor magnetic dent & shockwave rings + accumulate vertex stress
        if has_interactive {
            for v_idx in 0..VERT_COUNT {
                let idx = v_idx * 3;
                let p = [self.positions[idx], self.positions[idx + 1], self.positions[idx + 2]];
                let n = [self.normals[idx], self.normals[idx + 1], self.normals[idx + 2]];

                let mut disp_n = 0.0_f32;
                let mut extra_energy = 0.0_f32;

                if ptr_w > 0.005 {
                    let diff = v_sub(p, ptr);
                    let dist_sq = v_dot(diff, diff);
                    if dist_sq < 4.5 {
                        let dist = dist_sq.sqrt();
                        let falloff = (-dist_sq * 0.95).exp() * ptr_w;
                        let wave = (dist * 5.8 - t * 6.8).cos() * 0.28 * falloff;
                        disp_n += wave;
                        extra_energy += falloff * 0.95;
                        energy_accum += wave.abs();
                    }
                }

                if pulse_active && pulse_amp > 0.005 {
                    let diff = v_sub(p, pulse_origin);
                    let dist = v_dot(diff, diff).sqrt();
                    let delta = dist - pulse_front;
                    let envelope = (-delta * delta * 2.1).exp();
                    let wave = (delta * 5.8).cos() * 0.36 * pulse_amp * envelope;
                    disp_n += wave;
                    extra_energy += (envelope * pulse_amp * 1.35).min(1.6);
                    energy_accum += wave.abs() * 2.4;
                }

                if disp_n.abs() > 1e-5 {
                    self.positions[idx] += n[0] * disp_n;
                    self.positions[idx + 1] += n[1] * disp_n;
                    self.positions[idx + 2] += n[2] * disp_n;
                }
                self.energies[v_idx] = (self.energies[v_idx] + extra_energy).clamp(0.0, 1.5);
            }

            // Recompute final crisp normals after interactive displacement
            self.compute_normals(cyclic_v);
        }

        self.energy = (energy_accum / (VERT_COUNT as f32)) * 100.0 + turb * 0.36 + morph_strain;
    }
}

thread_local! {
    static MESH: RefCell<MeshEngine> = RefCell::new(MeshEngine::new());
}

#[no_mangle]
pub extern "C" fn mesh_init() -> u32 {
    MESH.with(|m| m.borrow_mut().init())
}

#[no_mangle]
pub extern "C" fn mesh_step(dt: f32, morph: f32) {
    MESH.with(|m| m.borrow_mut().step(dt, morph));
}

#[no_mangle]
pub extern "C" fn mesh_set_params(speed: f32, turbulence: f32, scale: f32) {
    MESH.with(|m| {
        let mut eng = m.borrow_mut();
        eng.speed = speed;
        eng.turbulence = turbulence;
        eng.scale = scale;
    });
}

#[no_mangle]
pub extern "C" fn mesh_set_pointer(x: f32, y: f32, z: f32, active: u32) {
    MESH.with(|m| {
        let mut eng = m.borrow_mut();
        eng.pointer_target = [x, y, z];
        eng.pointer_active = active != 0;
    });
}

#[no_mangle]
pub extern "C" fn mesh_pulse(x: f32, y: f32, z: f32, strength: f32) {
    MESH.with(|m| m.borrow_mut().trigger_pulse(x, y, z, strength));
}

#[no_mangle]
pub extern "C" fn mesh_positions_ptr() -> *const f32 {
    MESH.with(|m| m.borrow().positions.as_ptr())
}

#[no_mangle]
pub extern "C" fn mesh_normals_ptr() -> *const f32 {
    MESH.with(|m| m.borrow().normals.as_ptr())
}

#[no_mangle]
pub extern "C" fn mesh_energies_ptr() -> *const f32 {
    MESH.with(|m| m.borrow().energies.as_ptr())
}

#[no_mangle]
pub extern "C" fn mesh_indices_ptr() -> *const u32 {
    MESH.with(|m| m.borrow().indices.as_ptr())
}

#[no_mangle]
pub extern "C" fn mesh_vertex_count() -> u32 {
    VERT_COUNT as u32
}

#[no_mangle]
pub extern "C" fn mesh_index_count() -> u32 {
    INDEX_COUNT as u32
}

#[no_mangle]
pub extern "C" fn mesh_energy() -> f32 {
    MESH.with(|m| m.borrow().energy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_expected_topology() {
        let mut eng = MeshEngine::new();
        let verts = eng.init();
        assert_eq!(verts, 8_385);
        assert_eq!(eng.positions.len(), 8_385 * 3);
        assert_eq!(eng.normals.len(), 8_385 * 3);
        assert_eq!(eng.energies.len(), 8_385);
        assert_eq!(eng.indices.len(), 16_384 * 3);
    }

    #[test]
    fn all_morph_states_produce_finite_unit_normals_and_closed_seams() {
        let mut eng = MeshEngine::new();
        eng.init();
        for morph in [0.0_f32, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0] {
            eng.step(0.016, morph);
            for i in 0..VERT_COUNT {
                let nx = eng.normals[i * 3];
                let ny = eng.normals[i * 3 + 1];
                let nz = eng.normals[i * 3 + 2];
                let len = (nx * nx + ny * ny + nz * nz).sqrt();
                assert!(len.is_finite() && (len - 1.0).abs() < 1e-3, "bad normal at morph={morph} idx={i}");
            }
            // Verify cyclic U seam closure across every row
            for row in 0..ROWS {
                let first = (row * COLS) * 3;
                let last = (row * COLS + U_SEGS) * 3;
                for c in 0..3 {
                    assert!(
                        (eng.positions[first + c] - eng.positions[last + c]).abs() < 1e-4,
                        "U seam gap at morph={morph} row={row}"
                    );
                }
            }
        }
    }

    #[test]
    fn torus_seam_normal_points_outward_not_vertical() {
        let mut eng = MeshEngine::new();
        eng.init();
        eng.turbulence = 0.0;
        eng.step(0.016, 3.0); // Horizon torus: row 0 is outer equatorial rim (+X at col 0)
        let nx = eng.normals[0];
        let ny = eng.normals[1];
        assert!(nx > 0.95 && ny.abs() < 0.1, "horizon torus outer rim normal should be +X, got ({nx}, {ny})");
    }

    #[test]
    fn zero_speed_freezes_time_and_pulse_spikes_energy() {
        let mut eng = MeshEngine::new();
        eng.init();
        eng.speed = 0.0;
        let t0 = eng.time;
        eng.step(0.016, 0.0);
        assert_eq!(eng.time, t0);

        let baseline = eng.energy;
        eng.trigger_pulse(2.0, 0.0, 0.0, 1.6);
        eng.step(0.032, 0.0);
        assert!(eng.energy > baseline + 0.5, "pulse should spike surface energy");
    }
}
