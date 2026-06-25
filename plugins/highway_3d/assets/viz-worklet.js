/*
 * Slopsmith visualizer — audio feed AudioWorkletProcessor.
 * Generates Butterchurn's drive signal off the main thread (replaces the
 * deprecated ScriptProcessor): guitar PCM (gained) + a bass-band song-energy
 * pulse + a mid-band chart-accent pulse. The main thread pushes the latest
 * guitar frame and the song/chart/gain scalars via port messages.
 */
class VizFeedProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frame = null;   // latest guitar PCM (Float32Array)
        this.readIdx = 0;
        this.song = 0;
        this.chart = 0;
        this.gain = 6;
        this.phase = 0;
        this.phase2 = 0;
        this.osc = (2 * Math.PI * 90) / sampleRate;   // ~90 Hz  → bass band (song)
        this.osc2 = (2 * Math.PI * 520) / sampleRate; // ~520 Hz → mid band (chart)
        this.port.onmessage = (e) => {
            const d = e.data;
            if (!d) return;
            if (d.frame) { this.frame = d.frame; this.readIdx = 0; }
            if (typeof d.song === 'number') this.song = d.song;
            if (typeof d.chart === 'number') this.chart = d.chart;
            if (typeof d.gain === 'number') this.gain = d.gain;
        };
    }
    process(inputs, outputs) {
        const out = outputs[0] && outputs[0][0];
        if (!out) return true;
        const f = this.frame, fl = f ? f.length : 0;
        const TWO_PI = 2 * Math.PI;
        for (let i = 0; i < out.length; i++) {
            const g = (fl ? f[this.readIdx % fl] : 0) * this.gain;
            this.readIdx++;
            const song = this.song * (0.7 * Math.sin(this.phase) + 0.3 * (Math.random() * 2 - 1)) * 1.4;
            const chart = this.chart * (0.5 * Math.sin(this.phase2) + 0.5 * (Math.random() * 2 - 1)) * 1.5;
            this.phase += this.osc; if (this.phase > TWO_PI) this.phase -= TWO_PI;
            this.phase2 += this.osc2; if (this.phase2 > TWO_PI) this.phase2 -= TWO_PI;
            const v = g + song + chart;
            out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
        }
        return true;
    }
}
registerProcessor('viz-feed', VizFeedProcessor);
