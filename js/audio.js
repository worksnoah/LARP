import { AUDIO_TRACKS } from "./config.js?v=20260902d";

export class BattleAudio {
  constructor() { this.context = null; this.master = null; this.buffers = new Map(); this.source = null; this.muted = false; this.loading = null; this.loadComplete = false; this.pendingPlay = null; }

  async unlockAndPreload() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!this.context) {
      this.context = new AudioContext(); this.master = this.context.createGain();
      this.master.gain.value = .33; this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume().catch(() => {});
    if (!this.loading) this.loading = Promise.allSettled(AUDIO_TRACKS.map((url, index) => this.load(url, index + 1))).finally(() => {
      this.loadComplete = true;
      if (this.pendingPlay) {
        const pending = this.pendingPlay; this.pendingPlay = null;
        this.startBuffer(pending.trackIndex, pending.offsetSeconds + (performance.now() - pending.requestedAt) / 1000);
      }
    });
    return this.loading;
  }

  async load(url, index) {
    if (!this.context) return;
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Track ${index} unavailable`);
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer()); this.buffers.set(index, buffer);
  }

  play(trackIndex, offsetSeconds = 0) {
    if (!this.context || !this.master) return false; this.stopImmediately();
    if (!this.loadComplete) { this.pendingPlay = { trackIndex, offsetSeconds, requestedAt: performance.now() }; return false; }
    return this.startBuffer(trackIndex, offsetSeconds);
  }

  startBuffer(trackIndex, offsetSeconds) {
    const buffer = this.buffers.get(Number(trackIndex)) || [...this.buffers.entries()].sort(([a], [b]) => a - b)[0]?.[1];
    if (!buffer || !this.context || !this.master) return false;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.master);
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setValueAtTime(this.muted ? 0 : .33, this.context.currentTime);
    source.start(0, Math.max(0, offsetSeconds) % buffer.duration); this.source = source;
    source.onended = () => { if (this.source === source) this.source = null; }; return true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.context && this.master) this.master.gain.setTargetAtTime(muted ? 0 : .33, this.context.currentTime, .03);
  }

  fadeOut(duration = 1) {
    this.pendingPlay = null;
    if (!this.context || !this.master || !this.source) return;
    const now = this.context.currentTime; this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now); this.master.gain.linearRampToValueAtTime(0, now + duration);
    const source = this.source; setTimeout(() => { try { source.stop(); } catch {} if (this.source === source) this.source = null; }, duration * 1000 + 80);
  }

  stopImmediately() { this.pendingPlay = null; if (this.source) { try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; } }
}
