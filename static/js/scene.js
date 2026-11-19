import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RustMeshBridge } from "./wasm-bridge.js";
import { ForgeAudio } from "./forge-audio.js";

const DEFAULT_CONFIG = {
    material_slug: "obsidian",
    speed: 1.0,
    turbulence: 0.95,
    scale: 1.0,
    wireframe: false,
};

function readInitialConfig() {
    if (document.documentElement.dataset.static === "true") {
        try {
            const saved = localStorage.getItem("rwn-config");
            if (saved) return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
        } catch {
            // Fall through to embedded config
        }
    }
    const el = document.getElementById("initial-config");
    if (!el) return { ...DEFAULT_CONFIG };
    try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(el.textContent) };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

const CinemaGradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        uAberration: { value: 0.0008 },
        uVignette: { value: 0.34 },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uAberration;
        uniform float uVignette;
        varying vec2 vUv;
        void main() {
            vec2 offset = vUv - 0.5;
            float dist = length(offset);
            vec2 shift = offset * dist * uAberration * 2.2;

            float r = texture2D(tDiffuse, vUv + shift).r;
            float g = texture2D(tDiffuse, vUv).g;
            float b = texture2D(tDiffuse, vUv - shift).b;
            vec3 col = vec3(r, g, b);

            float vig = smoothstep(0.95, 0.34, dist);
            col *= mix(1.0 - uVignette, 1.0, vig);
            gl_FragColor = vec4(col, 1.0);
        }
    `,
};

function createSoftboxTexture(innerCss, midCss) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(128, 128, 6, 128, 128, 128);
    grad.addColorStop(0.0, innerCss);
    grad.addColorStop(0.48, midCss);
    grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

function createCycloramaTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, "#101218");
    grad.addColorStop(0.35, "#222530");
    grad.addColorStop(0.52, "#352c28");
    grad.addColorStop(0.7, "#1a1514");
    grad.addColorStop(1.0, "#0a090c");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function createBokehDustTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, "rgba(255, 245, 232, 1.0)");
    grad.addColorStop(0.4, "rgba(255, 224, 195, 0.5)");
    grad.addColorStop(1.0, "rgba(0, 0, 0, 0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

/**
 * Procedural Studio HDR Environment baked via PMREMGenerator.
 * Disposes every temporary geometry, material, and canvas texture immediately after baking.
 */
function buildStudioEnvironment(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x0c0d11);

    const disposables = [];
    const cycloTex = createCycloramaTexture();
    const softWarm = createSoftboxTexture("rgba(255,255,255,1)", "rgba(255,210,175,0.52)");
    const softCool = createSoftboxTexture("rgba(255,255,255,1)", "rgba(200,222,255,0.48)");
    disposables.push(cycloTex, softWarm, softCool);

    const domeGeo = new THREE.SphereGeometry(24, 32, 24);
    const domeMat = new THREE.MeshBasicMaterial({ map: cycloTex, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(domeGeo, domeMat));
    disposables.push(domeGeo, domeMat);

    const panels = [
        { w: 18, h: 11, pos: [9.4, 5.2, 6.0], col: [5.0, 2.2, 1.05], alpha: softWarm },
        { w: 10, h: 20, pos: [-9.5, 2.6, -5.5], col: [3.2, 3.9, 5.0], alpha: softCool },
        { w: 22, h: 5.5, pos: [0, 11.2, 1.5], col: [4.2, 4.0, 3.8], alpha: softWarm },
        { w: 20, h: 20, pos: [1.0, -9.5, 2.0], col: [2.0, 0.68, 0.24], alpha: softWarm },
        { w: 8, h: 14, pos: [-8.5, -0.5, 7.0], col: [1.9, 1.95, 2.1], alpha: softCool },
    ];

    for (const p of panels) {
        const g = new THREE.PlaneGeometry(p.w, p.h);
        const m = new THREE.MeshBasicMaterial({
            color: new THREE.Color(...p.col),
            alphaMap: p.alpha,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(...p.pos);
        mesh.lookAt(0, 0, 0);
        envScene.add(mesh);
        disposables.push(g, m);
    }

    const rt = pmrem.fromScene(envScene, 0.042);
    for (const item of disposables) item.dispose();
    pmrem.dispose();
    return rt.texture;
}

const MATERIAL_STYLES = {
    obsidian: {
        color: 0x16161c,
        metalness: 0.94,
        roughness: 0.19,
        clearcoat: 0.92,
        clearcoatRoughness: 0.08,
        iridescence: 0.62,
        iridescenceIOR: 1.42,
        iridescenceThicknessRange: [140, 420],
        envMapIntensity: 2.05,
        grainStrength: 0.14,
        veinColor: 0xff5a1f,
        veinGain: 1.85,
        opacity: 1.0,
        transparent: false,
        wireBaseOpacity: 0.0,
    },
    "molten-oxide": {
        color: 0xb64b22,
        metalness: 0.96,
        roughness: 0.24,
        clearcoat: 0.78,
        clearcoatRoughness: 0.12,
        iridescence: 0.45,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [180, 360],
        envMapIntensity: 2.15,
        grainStrength: 0.24,
        veinColor: 0xff8b36,
        veinGain: 2.1,
        opacity: 1.0,
        transparent: false,
        wireBaseOpacity: 0.0,
    },
    "liquid-mercury": {
        color: 0xd9dde6,
        metalness: 1.0,
        roughness: 0.075,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        iridescence: 0.42,
        iridescenceIOR: 1.36,
        iridescenceThicknessRange: [220, 500],
        envMapIntensity: 2.25,
        grainStrength: 0.06,
        veinColor: 0x8cc2ff,
        veinGain: 1.45,
        opacity: 1.0,
        transparent: false,
        wireBaseOpacity: 0.0,
    },
    topology: {
        color: 0x0f0f14,
        metalness: 0.85,
        roughness: 0.34,
        clearcoat: 0.4,
        clearcoatRoughness: 0.22,
        iridescence: 0.12,
        iridescenceIOR: 1.3,
        iridescenceThicknessRange: [120, 240],
        envMapIntensity: 1.15,
        grainStrength: 0.08,
        veinColor: 0xff5a1f,
        veinGain: 1.5,
        opacity: 0.78,
        transparent: true,
        wireBaseOpacity: 0.62,
    },
};

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function sampleKeyframes(keys, u) {
    const clamped = Math.max(0, Math.min(1, u));
    for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i];
        const b = keys[i + 1];
        if (clamped >= a.t && clamped <= b.t) {
            const local = (clamped - a.t) / Math.max(b.t - a.t, 1e-5);
            const s = local * local * (3 - 2 * local);
            return {
                meshX: lerp(a.meshX, b.meshX, s),
                meshY: lerp(a.meshY, b.meshY, s),
                camX: lerp(a.camX, b.camX, s),
                camY: lerp(a.camY, b.camY, s),
                camZ: lerp(a.camZ, b.camZ, s),
                ringScale: lerp(a.ringScale, b.ringScale, s),
                ringTilt: lerp(a.ringTilt, b.ringTilt, s),
                keyHue: lerp(a.keyHue, b.keyHue, s),
            };
        }
    }
    return keys[keys.length - 1];
}

function formatMorphLabel(morph) {
    const names = ["Monolith", "Kernel", "Forge", "Studio"];
    const seg = Math.min(2, Math.floor(morph));
    const frac = Math.max(0, Math.min(1, morph - seg));
    if (frac < 0.06) return `${names[seg]} · 0%`;
    if (frac > 0.94) return `${names[seg + 1]} · 100%`;
    return `${names[seg]} -> ${names[seg + 1]} ${Math.round(frac * 100)}%`;
}

function showFallback(message) {
    const fallback = document.getElementById("stage-fallback");
    const msgEl = document.getElementById("stage-fallback-msg");
    if (msgEl) msgEl.textContent = message;
    if (fallback) fallback.hidden = false;
}

async function boot() {
    const mount = document.getElementById("webgl-stage");
    if (!mount) return;

    const retryBtn = document.getElementById("btn-retry-stage");
    retryBtn?.addEventListener("click", () => window.location.reload());

    const config = readInitialConfig();
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let prefersReducedMotion = reducedMotionQuery.matches;

    const audio = new ForgeAudio();
    const announcer = document.getElementById("sr-announcer");
    function announce(text) {
        if (announcer) announcer.textContent = text;
    }

    // 1. Setup Three.js WebGL2 Renderer + Selective HDR Bloom Post-Processing
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: "high-performance",
            alpha: false,
        });
    } catch {
        showFallback("WebGL2 could not initialize on this device. You can still browse the architecture specification.");
        return;
    }

    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x030305, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    mount.appendChild(renderer.domElement);

    renderer.domElement.addEventListener("webglcontextlost", (ev) => {
        ev.preventDefault();
        showFallback("The WebGL2 graphics context was interrupted. Click Retry Studio to restore the forge.");
    });
    renderer.domElement.addEventListener("webglcontextrestored", () => {
        const fb = document.getElementById("stage-fallback");
        if (fb) fb.hidden = true;
    });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
        40,
        window.innerWidth / window.innerHeight,
        0.1,
        100
    );
    camera.position.set(0, 0.3, 9.5);

    const studioEnv = buildStudioEnvironment(renderer);
    scene.environment = studioEnv;

    // Dramatic physical studio lighting that shifts gently across chapters
    const keyLight = new THREE.DirectionalLight(0xffad7a, 2.7);
    keyLight.position.set(6, 5, 5);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ec0ff, 2.1);
    rimLight.position.set(-7, 3, -5);
    scene.add(rimLight);

    const underLight = new THREE.PointLight(0xe4502f, 5.8, 16, 1.8);
    underLight.position.set(1.2, -3.8, 2.4);
    scene.add(underLight);

    // EffectComposer: Render -> High-Threshold Selective HDR Bloom -> Cinema Grade -> Output
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.34, // controlled cinema strength
        0.45, // smooth radius
        0.82  // high threshold: ONLY molten veins & hot metal glints bloom
    );
    composer.addPass(bloomPass);

    const gradePass = new ShaderPass(CinemaGradeShader);
    composer.addPass(gradePass);
    composer.addPass(new OutputPass());

    // 2. Load Compiled Rust WASM Zero-Copy Sculpted Mesh & Stress Kernel
    const isStaticHost = document.documentElement.dataset.static === "true";
    const wasmUrl = document.documentElement.dataset.wasmUrl || "/wasm/rustwithnerco_wasm.wasm";
    let kernel;
    try {
        kernel = await RustMeshBridge.load(wasmUrl);
    } catch (err) {
        console.error("Rust WASM kernel failed:", err);
        const hdrSize = document.getElementById("hdr-wasm-size");
        if (hdrSize) {
            hdrSize.classList.add("is-warn");
            hdrSize.textContent = "wasm error";
        }
        showFallback("The Rust WebAssembly kernel failed to load from the server. Check that build.ps1 ran and retry.");
        return;
    }

    const meshStats = kernel.init();
    kernel.setParams({
        speed: prefersReducedMotion ? 0.0 : config.speed,
        turbulence: config.turbulence,
        scale: config.scale,
    });
    const views = kernel.getViews();

    const statVerts = document.getElementById("stat-verts");
    const statTris = document.getElementById("stat-tris");
    if (statVerts) statVerts.textContent = meshStats.vertexCount.toLocaleString();
    if (statTris) statTris.textContent = meshStats.triangleCount.toLocaleString();

    const sculptureGroup = new THREE.Group();
    scene.add(sculptureGroup);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(views.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(views.normals, 3));
    geometry.setAttribute("aEnergy", new THREE.BufferAttribute(views.energies, 1));
    geometry.setIndex(new THREE.BufferAttribute(views.indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6.5);

    // Authored GLSL Uniforms injected into MeshPhysicalMaterial via onBeforeCompile
    const shaderUniforms = {
        uGrainStrength: { value: 0.14 },
        uVeinColor: { value: new THREE.Color(0xff5a1f) },
        uVeinGain: { value: 1.85 },
        uXRayActive: { value: 0.0 },
        uXRaySplit: { value: 0.52 },
        uResolution: { value: new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr) },
        uIgniteY: { value: prefersReducedMotion ? 6.0 : -3.4 },
    };

    const surfaceMat = new THREE.MeshPhysicalMaterial({
        color: 0x16161c,
        metalness: 0.94,
        roughness: 0.19,
        clearcoat: 0.92,
        clearcoatRoughness: 0.08,
        iridescence: 0.62,
        iridescenceIOR: 1.42,
        iridescenceThicknessRange: [140, 420],
        envMapIntensity: 2.05,
        side: THREE.DoubleSide,
    });

    surfaceMat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, shaderUniforms);

        shader.vertexShader = shader.vertexShader
            .replace(
                "#include <common>",
                `#include <common>
                attribute float aEnergy;
                varying float vEnergy;
                varying vec3 vLocalPos;`
            )
            .replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>
                vEnergy = aEnergy;
                vLocalPos = position;`
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                "#include <common>",
                `#include <common>
                uniform float uGrainStrength;
                uniform vec3 uVeinColor;
                uniform float uVeinGain;
                uniform float uXRayActive;
                uniform float uXRaySplit;
                uniform vec2 uResolution;
                uniform float uIgniteY;
                varying float vEnergy;
                varying vec3 vLocalPos;`
            )
            .replace(
                "#include <roughnessmap_fragment>",
                `#include <roughnessmap_fragment>
                // Procedural micro-brushed anisotropic metallic grain
                float brushWave = sin(vLocalPos.y * 54.0 + sin(vLocalPos.x * 16.0) * 1.4) * 0.5 + 0.5;
                float fineNoise = fract(sin(dot(floor(vLocalPos.xz * 48.0), vec2(12.9898, 78.233))) * 43758.5453);
                roughnessFactor = clamp(roughnessFactor + (brushWave * 0.65 + fineNoise * 0.35 - 0.5) * uGrainStrength, 0.04, 0.85);`
            )
            .replace(
                "#include <emissivemap_fragment>",
                `#include <emissivemap_fragment>
                // Opening Forge Ignition scanline sweep (solidifies upward from glowing Rust wireframe)
                float igniteDelta = vLocalPos.y - uIgniteY;
                if (igniteDelta > 0.0) {
                    discard;
                }
                float igniteBand = smoothstep(-0.32, 0.0, igniteDelta) * step(uIgniteY, 4.8);

                // Interactive WASM X-Ray Split Curtain (clips PBR right of split to expose live Rust lattice)
                float screenX = gl_FragCoord.x / max(uResolution.x, 1.0);
                float xrayEdge = 0.0;
                if (uXRayActive > 0.5) {
                    if (screenX > uXRaySplit) {
                        discard;
                    }
                    xrayEdge = smoothstep(uXRaySplit - 0.008, uXRaySplit, screenX);
                }

                // Zero-copy Rust WASM strain-driven incandescent molten fissures
                float crack = smoothstep(0.24, 1.15, vEnergy);
                float ridgePulse = pow(crack, 1.45) * uVeinGain;
                totalEmissiveRadiance += uVeinColor * (ridgePulse + igniteBand * 2.6 + xrayEdge * 2.8);`
            );
    };

    const heroMesh = new THREE.Mesh(geometry, surfaceMat);
    heroMesh.frustumCulled = false;
    sculptureGroup.add(heroMesh);

    // Live Rust Linear-Memory Wireframe Lattice (revealed during Forge Ignition, X-Ray Split, or Topology finish)
    const wireMat = new THREE.MeshBasicMaterial({
        color: 0xf2632c,
        wireframe: true,
        transparent: true,
        opacity: prefersReducedMotion ? 0.0 : 0.48,
        depthWrite: false,
    });
    const wireOverlay = new THREE.Mesh(geometry, wireMat);
    wireOverlay.scale.setScalar(1.002);
    wireOverlay.visible = !prefersReducedMotion;
    sculptureGroup.add(wireOverlay);

    // 3. Single Precision Machined Forge Caliper Ring + Expanding Shockwave Echo Halo
    const caliperMat = new THREE.MeshPhysicalMaterial({
        color: 0x353740,
        metalness: 0.96,
        roughness: 0.22,
        clearcoat: 0.7,
        envMapIntensity: 1.9,
    });
    const caliperRing = new THREE.Mesh(
        new THREE.TorusGeometry(3.22, 0.015, 20, 180),
        caliperMat
    );
    caliperRing.rotation.x = Math.PI * 0.44;
    caliperRing.rotation.y = 0.22;
    sculptureGroup.add(caliperRing);

    const echoMat = new THREE.MeshBasicMaterial({
        color: 0xf05a28,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const echoRing = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.014, 12, 128), echoMat);
    sculptureGroup.add(echoRing);
    let echoAge = 99;

    // Circular soft-bokeh atmospheric depth motes (zero square pixels)
    const dustCount = 220;
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
        dustPos[i * 3] = (Math.random() - 0.5) * 24;
        dustPos[i * 3 + 1] = (Math.random() - 0.5) * 15;
        dustPos[i * 3 + 2] = -4.5 - Math.random() * 14;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    const dustTex = createBokehDustTexture();
    const dustField = new THREE.Points(
        dustGeo,
        new THREE.PointsMaterial({
            color: 0xe6dcd0,
            map: dustTex,
            size: 0.14,
            transparent: true,
            opacity: 0.34,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
    scene.add(dustField);

    // 4. Material Switching, WAI-ARIA Radiogroup, X-Ray Split Curtain & Audio
    const dockTabs = Array.from(document.querySelectorAll(".dock-tab"));
    const materialRows = Array.from(document.querySelectorAll(".material-row"));
    const elTurb = document.getElementById("ctrl-turbulence");
    const elSpeed = document.getElementById("ctrl-speed");
    const elScale = document.getElementById("ctrl-scale");
    const outTurb = document.getElementById("val-turbulence");
    const outSpeed = document.getElementById("val-speed");
    const outScale = document.getElementById("val-scale");
    const saveFeedback = document.getElementById("save-feedback");

    let activeMaterialStyle = MATERIAL_STYLES.obsidian;
    let xrayActive = false;
    let xraySplit = 0.52;
    let igniteDone = prefersReducedMotion;

    function syncWireVisibility() {
        const needsWire = !igniteDone || xrayActive || activeMaterialStyle.wireBaseOpacity > 0.01;
        wireOverlay.visible = needsWire;
        if (!igniteDone) {
            wireMat.opacity = 0.52;
        } else if (xrayActive) {
            wireMat.opacity = 0.55;
        } else {
            wireMat.opacity = activeMaterialStyle.wireBaseOpacity;
        }
    }

    function firePulseAt(x, y, z, strength = 1.55) {
        kernel.pulse(x, y, z, strength);
        echoAge = 0.0;
        echoRing.rotation.set(Math.random() * 0.6, Math.random() * 0.6, 0);
        audio.strike(strength * 0.7);
    }

    function applyMaterial(slug, triggerWave = false, silent = false) {
        const style = MATERIAL_STYLES[slug] || MATERIAL_STYLES.obsidian;
        activeMaterialStyle = style;
        config.material_slug = slug;
        config.wireframe = slug === "topology";

        surfaceMat.color.setHex(style.color);
        surfaceMat.metalness = style.metalness;
        surfaceMat.roughness = style.roughness;
        surfaceMat.clearcoat = style.clearcoat;
        surfaceMat.clearcoatRoughness = style.clearcoatRoughness;
        surfaceMat.iridescence = style.iridescence;
        surfaceMat.iridescenceIOR = style.iridescenceIOR;
        surfaceMat.iridescenceThicknessRange = style.iridescenceThicknessRange;
        surfaceMat.envMapIntensity = style.envMapIntensity;
        surfaceMat.opacity = style.opacity;
        surfaceMat.transparent = style.transparent;
        surfaceMat.needsUpdate = true;

        shaderUniforms.uGrainStrength.value = style.grainStrength;
        shaderUniforms.uVeinColor.value.setHex(style.veinColor);
        shaderUniforms.uVeinGain.value = style.veinGain;
        syncWireVisibility();

        dockTabs.forEach((btn) => {
            btn.setAttribute("aria-pressed", btn.dataset.material === slug ? "true" : "false");
        });
        materialRows.forEach((row) => {
            const match = row.dataset.material === slug;
            row.setAttribute("aria-checked", match ? "true" : "false");
            row.setAttribute("tabindex", match ? "0" : "-1");
        });

        if (triggerWave) {
            firePulseAt(0, 0, 2.0, 1.35);
        }
        if (!silent) {
            announce(`Surface finish changed to ${slug.replace("-", " ")}`);
        }
    }

    function paintSliders() {
        if (elTurb) elTurb.value = config.turbulence.toFixed(2);
        if (elSpeed) elSpeed.value = config.speed.toFixed(2);
        if (elScale) elScale.value = config.scale.toFixed(2);
        if (outTurb) outTurb.textContent = config.turbulence.toFixed(2);
        if (outSpeed) outSpeed.textContent = `${config.speed.toFixed(2)}x`;
        if (outScale) outScale.textContent = config.scale.toFixed(2);
    }

    function markDirty() {
        if (saveFeedback) {
            saveFeedback.textContent = "Unsaved adjustments — click Save to Axum to persist";
        }
    }

    applyMaterial(config.material_slug, false, true);
    paintSliders();

    function selectMaterialElement(el, focusRow = false) {
        const slug = el.dataset.material;
        config.speed = Number(el.dataset.speed);
        config.turbulence = Number(el.dataset.turbulence);
        config.scale = Number(el.dataset.scale);
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
        applyMaterial(slug, true, false);
        paintSliders();
        markDirty();
        if (focusRow) el.focus();
    }

    dockTabs.forEach((btn) => btn.addEventListener("click", () => selectMaterialElement(btn)));
    materialRows.forEach((row, idx) => {
        row.addEventListener("click", () => selectMaterialElement(row));
        // Full WAI-ARIA Radiogroup arrow-key & Home/End navigation
        row.addEventListener("keydown", (ev) => {
            let next = -1;
            if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
                next = (idx + 1) % materialRows.length;
            } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
                next = (idx - 1 + materialRows.length) % materialRows.length;
            } else if (ev.key === "Home") {
                next = 0;
            } else if (ev.key === "End") {
                next = materialRows.length - 1;
            }
            if (next >= 0) {
                ev.preventDefault();
                selectMaterialElement(materialRows[next], true);
            }
        });
    });

    elTurb?.addEventListener("input", () => {
        config.turbulence = Number(elTurb.value);
        outTurb.textContent = config.turbulence.toFixed(2);
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
        markDirty();
    });

    elSpeed?.addEventListener("input", () => {
        config.speed = Number(elSpeed.value);
        outSpeed.textContent = `${config.speed.toFixed(2)}x`;
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
        markDirty();
    });

    elScale?.addEventListener("input", () => {
        config.scale = Number(elScale.value);
        outScale.textContent = config.scale.toFixed(2);
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
        markDirty();
    });

    // WASM X-Ray Split Curtain Controls
    const xrayDivider = document.getElementById("xray-divider");
    const xrayHandle = document.getElementById("xray-handle");
    const xrayButtons = [
        document.getElementById("btn-hero-xray"),
        document.getElementById("btn-forge-xray"),
        document.getElementById("btn-closing-xray"),
        document.getElementById("btn-dock-xray"),
    ].filter(Boolean);

    function setXRaySplit(norm) {
        xraySplit = Math.max(0.1, Math.min(0.9, norm));
        shaderUniforms.uXRaySplit.value = xraySplit;
        if (xrayDivider) xrayDivider.style.left = `${(xraySplit * 100).toFixed(2)}%`;
        if (xrayHandle) xrayHandle.setAttribute("aria-valuenow", String(Math.round(xraySplit * 100)));
    }

    function setXRayActive(next) {
        xrayActive = next;
        shaderUniforms.uXRayActive.value = xrayActive ? 1.0 : 0.0;
        if (xrayDivider) {
            xrayDivider.classList.toggle("is-active", xrayActive);
            xrayDivider.setAttribute("aria-hidden", xrayActive ? "false" : "true");
        }
        xrayButtons.forEach((b) => b.setAttribute("aria-pressed", xrayActive ? "true" : "false"));
        syncWireVisibility();
        announce(xrayActive ? "WASM X-Ray split curtain enabled" : "WASM X-Ray split curtain closed");
    }

    setXRaySplit(0.52);
    xrayButtons.forEach((b) => b.addEventListener("click", () => setXRayActive(!xrayActive)));

    // Drag & keyboard control on X-Ray handle
    let draggingXRay = false;
    xrayHandle?.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        draggingXRay = true;
        xrayHandle.setPointerCapture(ev.pointerId);
    });
    xrayHandle?.addEventListener("pointermove", (ev) => {
        if (!draggingXRay) return;
        setXRaySplit(ev.clientX / Math.max(window.innerWidth, 1));
    });
    xrayHandle?.addEventListener("pointerup", () => {
        draggingXRay = false;
    });
    xrayHandle?.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowLeft") {
            ev.preventDefault();
            setXRaySplit(xraySplit - 0.04);
        } else if (ev.key === "ArrowRight") {
            ev.preventDefault();
            setXRaySplit(xraySplit + 0.04);
        } else if (ev.key === "Escape") {
            setXRayActive(false);
        }
    });

    // Audio Toggle & Shortcuts Dialog
    const btnAudio = document.getElementById("btn-audio-toggle");
    const audioLabel = document.getElementById("audio-label");
    const audioWaveOn = document.getElementById("audio-wave-on");
    const audioWaveOff = document.getElementById("audio-wave-off");

    function toggleAudioUi() {
        const active = audio.toggle();
        btnAudio?.setAttribute("aria-pressed", active ? "true" : "false");
        if (audioLabel) audioLabel.textContent = active ? "Forge On" : "Muted";
        if (audioWaveOn) audioWaveOn.style.display = active ? "" : "none";
        if (audioWaveOff) audioWaveOff.style.display = active ? "none" : "";
        if (active) audio.strike(0.8);
        announce(active ? "Forge resonance audio enabled" : "Forge audio muted");
    }
    btnAudio?.addEventListener("click", toggleAudioUi);

    const shortcutDialog = document.getElementById("shortcut-dialog");
    const btnOpenShortcuts = document.getElementById("btn-open-shortcuts");
    const btnCloseShortcuts = document.getElementById("btn-close-shortcuts");
    btnOpenShortcuts?.addEventListener("click", () => shortcutDialog?.showModal());
    btnCloseShortcuts?.addEventListener("click", () => {
        shortcutDialog?.close();
        btnOpenShortcuts?.focus();
    });
    shortcutDialog?.addEventListener("click", (ev) => {
        if (ev.target === shortcutDialog) {
            shortcutDialog.close();
            btnOpenShortcuts?.focus();
        }
    });

    document.getElementById("btn-wave-pulse")?.addEventListener("click", () => {
        firePulseAt(0, 0.25, 2.0, 1.7);
        announce("Surface shockwave triggered");
    });

    document.getElementById("btn-scroll-top")?.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
    });

    // Save to Axum (with in-flight disable) + Reset Defaults
    const btnSaveAxum = document.getElementById("btn-save-axum");
    const btnResetDefaults = document.getElementById("btn-reset-defaults");

    async function pollHealth() {
        if (isStaticHost) {
            if (saveFeedback) {
                saveFeedback.textContent = "Static GitHub Pages build · Rust WASM live in browser";
            }
            return;
        }
        try {
            const res = await fetch("/api/health");
            if (!res.ok) return;
            const data = await res.json();
            const reqEl = document.getElementById("stat-reqs");
            if (reqEl) reqEl.textContent = String(data.requests_served);
        } catch {
            // Silent ignore on server reload
        }
    }
    pollHealth();

    btnSaveAxum?.addEventListener("click", async () => {
        if (isStaticHost) {
            try {
                localStorage.setItem("rwn-config", JSON.stringify(config));
                if (saveFeedback) {
                    saveFeedback.textContent = `Saved (${config.material_slug} · turb ${config.turbulence.toFixed(2)}) in browser storage`;
                }
                announce("Sculpture configuration saved in browser storage");
            } catch {
                if (saveFeedback) saveFeedback.textContent = "Browser storage unavailable";
            }
            return;
        }
        btnSaveAxum.disabled = true;
        if (saveFeedback) saveFeedback.textContent = "Saving state to Axum server...";
        try {
            const res = await fetch("/api/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const saved = await res.json();
            if (saveFeedback) {
                saveFeedback.textContent = `Saved (${saved.material_slug} · turb ${saved.turbulence.toFixed(2)}) in Axum state`;
            }
            announce("Sculpture configuration saved to Axum server");
            pollHealth();
        } catch (err) {
            if (saveFeedback) saveFeedback.textContent = "Could not reach Axum /api/config — retry when server is online";
            console.error(err);
        } finally {
            btnSaveAxum.disabled = false;
        }
    });

    btnResetDefaults?.addEventListener("click", () => {
        Object.assign(config, DEFAULT_CONFIG);
        dragYaw = 0;
        dragPitch = 0;
        dragVelYaw = 0;
        dragVelPitch = 0;
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
        applyMaterial(config.material_slug, true, true);
        paintSliders();
        if (saveFeedback) saveFeedback.textContent = "Reset to Forged Obsidian defaults";
        announce("Reset to Forged Obsidian defaults");
    });

    // 5. Scroll Choreography, Unified Chapter Rail & Smart Dock Auto-Recede
    const railFill = document.getElementById("rail-fill");
    const mobileProgressFill = document.getElementById("mobile-progress-fill");
    const railStops = Array.from(document.querySelectorAll(".rail-stop"));
    const studioDock = document.getElementById("studio-dock");
    const dockMorphReadout = document.getElementById("dock-morph-readout");

    railStops.forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = document.getElementById(btn.dataset.scrollTo);
            target?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
        });
    });

    let targetScroll = 0;
    let smoothScroll = 0;
    let cachedWide = window.innerWidth >= 900;

    function readScrollProgress() {
        const maxScroll = Math.max(
            document.documentElement.scrollHeight - window.innerHeight,
            1
        );
        targetScroll = Math.max(0, Math.min(1, window.scrollY / maxScroll));
    }
    readScrollProgress();
    window.addEventListener("scroll", readScrollProgress, { passive: true });

    const DESKTOP_KEYS = [
        { t: 0.0,  meshX: 2.32,  meshY: 0.12, camX: 0.0,  camY: 0.3,  camZ: 9.6,  ringScale: 0.86, ringTilt: 0.16, keyHue: 0.06 },
        { t: 0.34, meshX: -2.25, meshY: 0.06, camX: -0.2, camY: 0.55, camZ: 9.1,  ringScale: 0.94, ringTilt: 0.65, keyHue: 0.09 },
        { t: 0.68, meshX: 2.25,  meshY: 0.04, camX: 0.22, camY: 0.15, camZ: 8.6,  ringScale: 1.02, ringTilt: 1.15, keyHue: 0.05 },
        { t: 1.0,  meshX: 0.0,   meshY: 1.38, camX: 0.0,  camY: 0.45, camZ: 10.4, ringScale: 1.08, ringTilt: 0.24, keyHue: 0.07 },
    ];
    const MOBILE_KEYS = [
        { t: 0.0,  meshX: 0.0, meshY: 1.35, camX: 0.0, camY: 0.25, camZ: 10.5, ringScale: 0.76, ringTilt: 0.2,  keyHue: 0.06 },
        { t: 0.34, meshX: 0.0, meshY: 1.25, camX: 0.0, camY: 0.45, camZ: 10.1, ringScale: 0.84, ringTilt: 0.65, keyHue: 0.09 },
        { t: 0.68, meshX: 0.0, meshY: 1.42, camX: 0.0, camY: 0.2,  camZ: 10.1, ringScale: 0.88, ringTilt: 1.05, keyHue: 0.05 },
        { t: 1.0,  meshX: 0.0, meshY: 1.55, camX: 0.0, camY: 0.35, camZ: 10.9, ringScale: 0.94, ringTilt: 0.25, keyHue: 0.07 },
    ];

    // 6. Exact Mesh-Local Raycasting, Click-Drag Free Orbit & Magnetic Reticle
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2(0, 0);
    const smoothPointer = new THREE.Vector2(0, 0);
    const _camDir = new THREE.Vector3();
    const _hitPlane = new THREE.Plane();
    const _worldHit = new THREE.Vector3();
    const _localHit = new THREE.Vector3();

    const reticle = document.getElementById("cursor-reticle");
    const reticleTag = document.getElementById("reticle-tag");
    let retX = -100, retY = -100, retTargetX = -100, retTargetY = -100;
    let onMesh = false;

    let pointerDown = false;
    let pointerMoved = false;
    let downX = 0, downY = 0, downTime = 0;
    let lastDragX = 0, lastDragY = 0;
    let dragYaw = 0, dragPitch = 0;
    let dragVelYaw = 0, dragVelPitch = 0;

    function intersectMeshLocal(clientX, clientY) {
        pointerNdc.x = (clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
        pointerNdc.y = -(clientY / Math.max(window.innerHeight, 1)) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);

        const hits = raycaster.intersectObject(heroMesh, false);
        if (hits.length > 0) {
            _localHit.copy(hits[0].point);
            heroMesh.worldToLocal(_localHit);
            return { hit: true, exact: true, point: _localHit };
        }

        // Fallback plane centered on heroMesh transformed into rotated heroMesh local space
        camera.getWorldDirection(_camDir);
        _hitPlane.setFromNormalAndCoplanarPoint(_camDir.negate(), sculptureGroup.position);
        if (raycaster.ray.intersectPlane(_hitPlane, _worldHit)) {
            _localHit.copy(_worldHit);
            heroMesh.worldToLocal(_localHit);
            return { hit: true, exact: false, point: _localHit };
        }
        return { hit: false, exact: false, point: _localHit };
    }

    window.addEventListener("pointermove", (ev) => {
        retTargetX = ev.clientX;
        retTargetY = ev.clientY;
        reticle?.classList.add("is-visible");

        if (pointerDown && !draggingXRay) {
            const dx = ev.clientX - lastDragX;
            const dy = ev.clientY - lastDragY;
            if (Math.hypot(ev.clientX - downX, ev.clientY - downY) >= 8) {
                pointerMoved = true;
                mount.classList.add("is-orbiting");
                reticle?.classList.add("is-dragging");
                if (reticleTag) reticleTag.textContent = "Orbiting";
            }
            if (pointerMoved) {
                dragVelYaw = dx * 0.0065;
                dragVelPitch = dy * 0.005;
                dragYaw += dragVelYaw;
                dragPitch = Math.max(-1.1, Math.min(1.1, dragPitch + dragVelPitch));
            }
            lastDragX = ev.clientX;
            lastDragY = ev.clientY;
        }

        const res = intersectMeshLocal(ev.clientX, ev.clientY);
        onMesh = res.exact;
        reticle?.classList.toggle("is-on-mesh", onMesh && !pointerMoved);
        if (!pointerMoved && reticleTag) {
            reticleTag.textContent = "Strike / Drag";
        }
        if (res.hit) {
            kernel.setPointer(res.point.x, res.point.y, res.point.z, res.exact);
        }
    });

    window.addEventListener("pointerleave", () => {
        kernel.setPointer(0, 0, 0, false);
        reticle?.classList.remove("is-visible", "is-on-mesh", "is-dragging");
    });

    window.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("a, button, input, label, dialog, .studio-dock, .cinema-header, .chapter-rail, .xray-handle")) {
            return;
        }
        pointerDown = true;
        pointerMoved = false;
        downX = lastDragX = ev.clientX;
        downY = lastDragY = ev.clientY;
        downTime = performance.now();
    });

    window.addEventListener("pointerup", (ev) => {
        if (!pointerDown) return;
        pointerDown = false;
        mount.classList.remove("is-orbiting");
        reticle?.classList.remove("is-dragging");

        const dist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        const elapsedMs = performance.now() - downTime;
        // Fire shockwave strictly on crisp taps/clicks (never on scroll swipes or orbit drags)
        if (dist < 8 && elapsedMs < 260) {
            const res = intersectMeshLocal(ev.clientX, ev.clientY);
            if (res.hit) {
                firePulseAt(res.point.x, res.point.y, res.point.z, 1.7);
            } else {
                firePulseAt(0, 0, 2.0, 1.55);
            }
        }
        pointerMoved = false;
    });

    // Safe Keyboard Accelerators (Never hijacks Spacebar or active form/button focus!)
    window.addEventListener("keydown", (ev) => {
        const tag = (ev.target && ev.target.tagName) || "";
        const inControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A";
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

        if (ev.key === "Escape") {
            if (xrayActive) setXRayActive(false);
            return;
        }
        if (inControl) return;

        if (ev.key === "p" || ev.key === "P") {
            ev.preventDefault();
            firePulseAt(0, 0.2, 2.0, 1.7);
        } else if (ev.key === "x" || ev.key === "X") {
            ev.preventDefault();
            setXRayActive(!xrayActive);
        } else if (ev.key === "m" || ev.key === "M") {
            ev.preventDefault();
            toggleAudioUi();
        } else if (ev.key === "r" || ev.key === "R") {
            ev.preventDefault();
            dragYaw = 0;
            dragPitch = 0;
            dragVelYaw = 0;
            dragVelPitch = 0;
            announce("Orbit angle reset");
        } else if (ev.key === "?") {
            ev.preventDefault();
            shortcutDialog?.showModal();
        } else if (ev.key >= "1" && ev.key <= "4") {
            const tab = dockTabs[Number(ev.key) - 1];
            if (tab) {
                ev.preventDefault();
                selectMaterialElement(tab);
            }
        }
    });

    // Live prefers-reduced-motion reaction
    reducedMotionQuery.addEventListener("change", (ev) => {
        prefersReducedMotion = ev.matches;
        kernel.setParams({
            speed: prefersReducedMotion ? 0.0 : config.speed,
            turbulence: config.turbulence,
            scale: config.scale,
        });
    });

    window.addEventListener("resize", () => {
        const nextDpr = Math.min(window.devicePixelRatio, 2);
        cachedWide = window.innerWidth >= 900;
        camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(nextDpr);
        renderer.setSize(window.innerWidth, window.innerHeight);
        composer.setSize(window.innerWidth, window.innerHeight);
        bloomPass.resolution.set(window.innerWidth, window.innerHeight);
        shaderUniforms.uResolution.value.set(window.innerWidth * nextDpr, window.innerHeight * nextDpr);
        readScrollProgress();
    });

    // 7. Main Cinema Render Loop (Pauses cleanly on document.hidden)
    const hdrFps = document.getElementById("hdr-fps");
    const hdrWasmMs = document.getElementById("hdr-wasm-ms");
    const statWasmStep = document.getElementById("stat-wasm-step");
    const statEnergy = document.getElementById("stat-energy");

    let rafId = 0;
    let lastTime = performance.now();
    let frames = 0;
    let fpsAccum = 0;
    let stepAccum = 0;
    let elapsed = 0;
    let prevActiveIdx = -1;
    let prevInForge = false;
    let prevScrollRender = -1;

    document.addEventListener("visibilitychange", () => {
        audio.setHidden(document.hidden);
        if (document.hidden) {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
        } else {
            lastTime = performance.now();
            if (!rafId) rafId = requestAnimationFrame(animate);
        }
    });

    function animate(now) {
        rafId = requestAnimationFrame(animate);
        const dt = Math.min((now - lastTime) * 0.001, 0.05);
        lastTime = now;
        elapsed += dt;

        // Forge Ignition 900ms opening reveal (wireframe solidifies upward into forged obsidian)
        if (!igniteDone) {
            const prog = Math.min(1, elapsed / 0.95);
            const eased = 1 - Math.pow(1 - prog, 3);
            shaderUniforms.uIgniteY.value = lerp(-3.4, 5.2, eased);
            if (prog >= 1) {
                igniteDone = true;
                syncWireVisibility();
            }
        }

        // Smooth scroll & pointer damping
        const damp = prefersReducedMotion ? 1.0 : Math.min(dt * 6.8, 1.0);
        smoothScroll += (targetScroll - smoothScroll) * damp;
        smoothPointer.x += (pointerNdc.x - smoothPointer.x) * Math.min(dt * 4.5, 1.0);
        smoothPointer.y += (pointerNdc.y - smoothPointer.y) * Math.min(dt * 4.5, 1.0);

        // Inertial free-orbit velocity decay
        if (!pointerDown) {
            dragVelYaw *= Math.exp(-5.0 * dt);
            dragVelPitch *= Math.exp(-5.0 * dt);
            dragYaw += dragVelYaw;
            dragPitch = Math.max(-1.1, Math.min(1.1, dragPitch + dragVelPitch));
        }

        // Magnetic cursor reticle smooth glide
        if (reticle) {
            retX += (retTargetX - retX) * Math.min(dt * 18, 1);
            retY += (retTargetY - retY) * Math.min(dt * 18, 1);
            reticle.style.transform = `translate3d(${retX.toFixed(1)}px, ${retY.toFixed(1)}px, 0)`;
        }

        // Diff-guarded scroll rail & dock updates (zero per-frame DOM thrash)
        if (Math.abs(smoothScroll - prevScrollRender) > 0.0004) {
            prevScrollRender = smoothScroll;
            const scaleVal = Math.max(0.02, smoothScroll).toFixed(4);
            if (railFill) railFill.style.transform = `scaleY(${scaleVal})`;
            if (mobileProgressFill) mobileProgressFill.style.transform = `scaleX(${scaleVal})`;

            const activeIdx = Math.min(3, Math.floor(smoothScroll * 3.6 + 0.25));
            if (activeIdx !== prevActiveIdx) {
                prevActiveIdx = activeIdx;
                railStops.forEach((stop, i) => {
                    const isCur = i === activeIdx;
                    stop.classList.toggle("is-active", isCur);
                    if (isCur) {
                        stop.setAttribute("aria-current", "location");
                    } else {
                        stop.removeAttribute("aria-current");
                    }
                });
            }

            // Auto-recede bottom dock while Chapter 3 Forge is centered (no duplicate lists)
            const inForge = smoothScroll > 0.54 && smoothScroll < 0.86;
            if (inForge !== prevInForge) {
                prevInForge = inForge;
                studioDock?.classList.toggle("is-receded", inForge);
            }
        }

        // Run zero-copy Rust WASM mesh morph + normals + stress energy kernel
        const morph = smoothScroll * 3.0;
        const t0 = performance.now();
        kernel.step(dt, morph);
        const stepMs = performance.now() - t0;

        const currentViews = kernel.getViews();
        if (geometry.attributes.position.array !== currentViews.positions) {
            geometry.attributes.position.array = currentViews.positions;
            geometry.attributes.normal.array = currentViews.normals;
            geometry.attributes.aEnergy.array = currentViews.energies;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.normal.needsUpdate = true;
        geometry.attributes.aEnergy.needsUpdate = true;

        // Scroll-choreographed camera, lighting, and sculpture motion
        const kf = sampleKeyframes(cachedWide ? DESKTOP_KEYS : MOBILE_KEYS, smoothScroll);
        const idleSpin = prefersReducedMotion ? 0.0 : 1.0;

        sculptureGroup.position.x = kf.meshX;
        sculptureGroup.position.y = kf.meshY + (prefersReducedMotion ? 0 : Math.sin(elapsed * 0.68) * 0.07);

        heroMesh.rotation.y = elapsed * 0.2 * config.speed * idleSpin + smoothScroll * Math.PI * 1.35 + dragYaw + smoothPointer.x * 0.24 * idleSpin;
        heroMesh.rotation.x = Math.sin(elapsed * 0.34) * 0.1 * idleSpin + smoothScroll * 0.55 + dragPitch - smoothPointer.y * 0.18 * idleSpin;
        wireOverlay.rotation.copy(heroMesh.rotation);

        caliperRing.scale.setScalar(kf.ringScale);
        caliperRing.rotation.y = elapsed * 0.12 * idleSpin - smoothScroll * 1.4 + dragYaw * 0.4;
        caliperRing.rotation.x = Math.PI * 0.44 + kf.ringTilt * 0.35 + dragPitch * 0.25;

        // Expanding shockwave echo ring animation
        if (echoAge < 1.3) {
            echoAge += dt;
            const p = echoAge / 1.3;
            echoRing.scale.setScalar(0.95 + p * 1.15);
            echoMat.opacity = Math.pow(1 - p, 2.2) * 0.52;
        } else if (echoMat.opacity !== 0) {
            echoMat.opacity = 0;
        }

        // Dynamic per-chapter key light warmth + energy-coupled subtle chromatic aberration
        const energy = kernel.energy();
        keyLight.color.setHSL(kf.keyHue, 0.82, 0.72);
        underLight.intensity = 5.4 + Math.min(energy * 1.6, 5.5);
        gradePass.uniforms.uAberration.value = 0.0005 + Math.min(energy * 0.00035, 0.0022);

        const portraitZoom = camera.aspect < 0.85
            ? Math.min(1.62, 0.9 / Math.max(camera.aspect, 0.45))
            : 1.0;
        camera.position.x = kf.camX + smoothPointer.x * 0.32 * idleSpin;
        camera.position.y = kf.camY + smoothPointer.y * 0.22 * idleSpin;
        camera.position.z = kf.camZ * portraitZoom;
        camera.lookAt(kf.meshX * 0.12, kf.meshY * 0.18, 0);

        dustField.rotation.y = elapsed * 0.012 * idleSpin + smoothPointer.x * 0.03 * idleSpin;
        dustField.position.y = -smoothScroll * 2.0;

        audio.modulate(energy, smoothScroll);
        composer.render();

        frames += 1;
        fpsAccum += dt;
        stepAccum += stepMs;
        if (fpsAccum >= 0.35) {
            const fps = Math.round(frames / fpsAccum);
            const avgStep = (stepAccum / frames).toFixed(2);
            if (hdrFps) hdrFps.textContent = `${fps} fps`;
            if (hdrWasmMs) hdrWasmMs.textContent = `${avgStep} ms`;
            if (statWasmStep) statWasmStep.textContent = `${avgStep} ms`;
            if (statEnergy) statEnergy.textContent = energy.toFixed(2);
            if (dockMorphReadout) dockMorphReadout.textContent = formatMorphLabel(morph);
            frames = 0;
            fpsAccum = 0;
            stepAccum = 0;
        }
    }

    rafId = requestAnimationFrame(animate);
}

boot();
