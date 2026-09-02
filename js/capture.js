import { CAPTURE_TIMES_SECONDS } from "./config.js?v=20260902d";

export function captureFrame(video, maxDimension = 512, quality = .6) {
  if (!video?.videoWidth || !video?.videoHeight) throw new Error("Video frame is not ready");
  const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale)); const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false }); context.drawImage(video, 0, 0, width, height);
  const data = canvas.toDataURL("image/jpeg", quality); canvas.width = 1; canvas.height = 1; return data;
}

function sampleVideo(video) {
  const canvas = document.createElement("canvas"); canvas.width = 24; canvas.height = 18;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const sample = new Uint8Array(canvas.width * canvas.height);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) sample[target] = Math.round(pixels[source] * .299 + pixels[source + 1] * .587 + pixels[source + 2] * .114);
  canvas.width = 1; canvas.height = 1; return sample;
}

function visualEnergy(sample, previous) {
  let mean = 0; for (const value of sample) mean += value; mean /= sample.length;
  let contrast = 0, motion = 0;
  for (let index = 0; index < sample.length; index += 1) {
    contrast += Math.abs(sample[index] - mean) / 255;
    if (previous) motion += Math.abs(sample[index] - previous[index]) / 255;
  }
  contrast /= sample.length; motion = previous ? motion / sample.length : 0;
  return Math.round(Math.max(1, Math.min(9.5, 3 + contrast * 12 + motion * 20)) * 10) / 10;
}

export class FrameCollector {
  constructor(playerAVideo, playerBVideo) { this.playerAVideo = playerAVideo; this.playerBVideo = playerBVideo; this.frames = { playerA: [], playerB: [] }; this.samples = { playerA: null, playerB: null }; this.timers = []; this.active = false; }
  start(onCapture) {
    this.active = true;
    CAPTURE_TIMES_SECONDS.forEach((second) => this.timers.push(setTimeout(() => {
      if (!this.active) return;
      try {
        this.frames.playerA.push(captureFrame(this.playerAVideo)); this.frames.playerB.push(captureFrame(this.playerBVideo));
        const sampleA = sampleVideo(this.playerAVideo), sampleB = sampleVideo(this.playerBVideo);
        const pulse = {
          second, playerA: visualEnergy(sampleA, this.samples.playerA), playerB: visualEnergy(sampleB, this.samples.playerB),
          callout: "On-device energy estimate — final AI verdict after the bell.",
        };
        this.samples = { playerA: sampleA, playerB: sampleB }; onCapture?.(second, this.frames, pulse);
      } catch (error) { console.warn("Frame capture skipped", error); }
    }, second * 1000)));
  }
  stop() { this.active = false; this.timers.forEach(clearTimeout); this.timers = []; return this.frames; }
  clear() { this.stop(); this.frames.playerA.length = 0; this.frames.playerB.length = 0; }
}
