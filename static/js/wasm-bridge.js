/**
 * Zero-copy bridge between Rust wasm32-unknown-unknown linear memory
 * and Three.js BufferGeometry (positions, normals, strain energies, indices).
 */
export class RustMeshBridge {
    constructor(instance) {
        this.exports = instance.exports;
        this.memory = this.exports.memory;
        this.vertexCount = 0;
        this.indexCount = 0;
        this._bufferRef = null;
        this._positions = null;
        this._normals = null;
        this._energies = null;
        this._indices = null;
    }

    static async load(url = "/wasm/rustwithnerco_wasm.wasm") {
        let result;
        if (typeof WebAssembly.instantiateStreaming === "function") {
            try {
                result = await WebAssembly.instantiateStreaming(fetch(url), {});
            } catch {
                const resp = await fetch(url);
                if (!resp.ok) {
                    throw new Error(`Failed to fetch WASM kernel (HTTP ${resp.status})`);
                }
                const bytes = await resp.arrayBuffer();
                result = await WebAssembly.instantiate(bytes, {});
            }
        } else {
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`Failed to fetch WASM kernel (HTTP ${resp.status})`);
            }
            const bytes = await resp.arrayBuffer();
            result = await WebAssembly.instantiate(bytes, {});
        }
        return new RustMeshBridge(result.instance);
    }

    init() {
        this.vertexCount = this.exports.mesh_init() >>> 0;
        this.indexCount = this.exports.mesh_index_count() >>> 0;
        this._refreshViews(true);
        return {
            vertexCount: this.vertexCount,
            triangleCount: Math.floor(this.indexCount / 3),
        };
    }

    setParams({ speed, turbulence, scale }) {
        this.exports.mesh_set_params(speed, turbulence, scale);
    }

    setPointer(x, y, z, active) {
        this.exports.mesh_set_pointer(x, y, z, active ? 1 : 0);
    }

    pulse(x, y, z, strength = 1.45) {
        this.exports.mesh_pulse(x, y, z, strength);
    }

    step(dt, morph) {
        this.exports.mesh_step(dt, morph);
        if (this._bufferRef !== this.memory.buffer) {
            this._refreshViews(true);
        }
    }

    energy() {
        return this.exports.mesh_energy();
    }

    getViews() {
        this._refreshViews(false);
        return {
            positions: this._positions,
            normals: this._normals,
            energies: this._energies,
            indices: this._indices,
            vertexCount: this.vertexCount,
            triangleCount: Math.floor(this.indexCount / 3),
        };
    }

    _refreshViews(force) {
        if (!force && this._bufferRef === this.memory.buffer && this._positions && this._normals && this._energies) {
            return;
        }
        const buf = this.memory.buffer;
        const posPtr = this.exports.mesh_positions_ptr() >>> 0;
        const normPtr = this.exports.mesh_normals_ptr() >>> 0;
        const energyPtr = this.exports.mesh_energies_ptr() >>> 0;
        const idxPtr = this.exports.mesh_indices_ptr() >>> 0;
        const floatLen = this.vertexCount * 3;
        this._bufferRef = buf;
        this._positions = new Float32Array(buf, posPtr, floatLen);
        this._normals = new Float32Array(buf, normPtr, floatLen);
        this._energies = new Float32Array(buf, energyPtr, this.vertexCount);
        this._indices = new Uint32Array(buf, idxPtr, this.indexCount);
    }
}
