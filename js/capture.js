import { CAPTURE_TIMES_SECONDS } from "./config.js";

export function captureFrame(video, maxDimension = 512, quality = .6) {
  if (!video?.videoWidth || !video?.videoHeight) throw new Error("Video frame is not ready");
  const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale)); const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false }); context.drawImage(video, 0, 0, width, height);
  const data = canvas.toDataURL("image/jpeg", quality); canvas.width = 1; canvas.height = 1; return data;
}

export class FrameCollector {
  constructor(playerAVideo, playerBVideo) { this.playerAVideo = playerAVideo; this.playerBVideo = playerBVideo; this.frames = { playerA: [], playerB: [] }; this.timers = []; this.active = false; }
  start(onCapture) {
    this.active = true;
    CAPTURE_TIMES_SECONDS.forEach((second) => this.timers.push(setTimeout(() => {
      if (!this.active) return;
      try {
        this.frames.playerA.push(captureFrame(this.playerAVideo)); this.frames.playerB.push(captureFrame(this.playerBVideo));
        onCapture?.(second, this.frames);
      } catch (error) { console.warn("Frame capture skipped", error); }
    }, second * 1000)));
  }
  stop() { this.active = false; this.timers.forEach(clearTimeout); this.timers = []; return this.frames; }
  clear() { this.stop(); this.frames.playerA.length = 0; this.frames.playerB.length = 0; }
}
