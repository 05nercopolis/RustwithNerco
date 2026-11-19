/**
 * Opt-in procedural Web Audio forge synthesizer (muted by default).
 * Driven live by Rust WASM strain energy & scroll morph without external audio assets.
 */
export class ForgeAudio {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.filter = null;
        this.oscSub = null;
        this.oscHarm = null;
        this.enabled = false;
        this.hidden = false;
    }

    toggle() {
        if (this.enabled) {
            this.disable();
            return false;
        }
        return this.enable();
    }

    enable() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return false;
        try {
            if (!this.ctx) {
                this.ctx = new AudioCtx();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.0;
                this.master.connect(this.ctx.destination);

                this.filter = this.ctx.createBiquadFilter();
                this.filter.type = "lowpass";
                this.filter.frequency.value = 180;
                this.filter.Q.value = 3.2;
                this.filter.connect(this.master);

                this.oscSub = this.ctx.createOscillator();
                this.oscSub.type = "sine";
                this.oscSub.frequency.value = 55; // A1 resonant drone
                const subGain = this.ctx.createGain();
                subGain.gain.value = 0.45;
                this.oscSub.connect(subGain);
                subGain.connect(this.filter);

                this.oscHarm = this.ctx.createOscillator();
                this.oscHarm.type = "triangle";
                this.oscHarm.frequency.value = 110.4;
                const harmGain = this.ctx.createGain();
                harmGain.gain.value = 0.16;
                this.oscHarm.connect(harmGain);
                harmGain.connect(this.filter);

                this.oscSub.start();
                this.oscHarm.start();
            }

            if (this.ctx.state === "suspended") {
                this.ctx.resume();
            }
            this.enabled = true;
            this._applyMasterGain();
            return true;
        } catch {
            return false;
        }
    }

    disable() {
        this.enabled = false;
        this._applyMasterGain();
    }

    setHidden(hidden) {
        this.hidden = hidden;
        this._applyMasterGain();
    }

    _applyMasterGain() {
        if (!this.ctx || !this.master) return;
        const now = this.ctx.currentTime;
        const target = this.enabled && !this.hidden ? 0.12 : 0.0;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(target, now, 0.14);
    }

    modulate(energy, scroll) {
        if (!this.enabled || this.hidden || !this.ctx || !this.filter) return;
        const now = this.ctx.currentTime;
        const cutoff = Math.min(720, 130 + energy * 48 + scroll * 140);
        const pitch = 55 + scroll * 18;
        this.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
        this.oscSub?.frequency.setTargetAtTime(pitch, now, 0.15);
        this.oscHarm?.frequency.setTargetAtTime(pitch * 2.008, now, 0.15);
    }

    strike(strength = 1.0) {
        if (!this.enabled || this.hidden || !this.ctx || !this.master) return;
        const now = this.ctx.currentTime;

        // Sub-bass forged thump
        const body = this.ctx.createOscillator();
        const bodyGain = this.ctx.createGain();
        body.type = "sine";
        body.frequency.setValueAtTime(118, now);
        body.frequency.exponentialRampToValueAtTime(38, now + 0.42);
        bodyGain.gain.setValueAtTime(0.32 * Math.min(strength, 1.4), now);
        bodyGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.52);
        body.connect(bodyGain);
        bodyGain.connect(this.master);
        body.start(now);
        body.stop(now + 0.55);

        // Metallic harmonic overtone ring
        const chime = this.ctx.createOscillator();
        const chimeGain = this.ctx.createGain();
        chime.type = "triangle";
        chime.frequency.setValueAtTime(440 + Math.random() * 140, now);
        chime.frequency.exponentialRampToValueAtTime(310, now + 0.7);
        chimeGain.gain.setValueAtTime(0.08 * Math.min(strength, 1.4), now);
        chimeGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.72);
        chime.connect(chimeGain);
        chimeGain.connect(this.master);
        chime.start(now);
        chime.stop(now + 0.75);
    }
}
