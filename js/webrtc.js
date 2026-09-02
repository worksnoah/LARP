import { ICE_SERVERS } from "./config.js?v=20260902d";

export class PeerSession {
  constructor({ supabase, match, clientId, localStream, onRemoteStream, onMatchEvent, onFailure, onOpponentLeft }) {
    this.supabase = supabase; this.match = match; this.clientId = clientId; this.localStream = localStream;
    this.onRemoteStream = onRemoteStream; this.onMatchEvent = onMatchEvent; this.onFailure = onFailure; this.onOpponentLeft = onOpponentLeft;
    this.isPlayerA = match.player_a === clientId; this.channel = null; this.pc = null; this.pendingIce = [];
    this.remoteReady = false; this.closed = false; this.offerSent = false; this.readyInterval = null; this.connectionTimer = null;
    this.realtimeErrorTimer = null; this.realtimeSubscribed = false;
  }

  async connect() {
    this.createPeerConnection();
    this.channel = this.supabase.channel(`larp-match:${this.match.id}`, { config: { broadcast: { ack: true, self: false } } });
    this.channel.on("broadcast", { event: "signal" }, ({ payload }) => this.handleSignal(payload));
    this.channel.on("broadcast", { event: "match-event" }, ({ payload }) => this.onMatchEvent?.(payload));
    this.channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        this.realtimeSubscribed = true; clearTimeout(this.realtimeErrorTimer);
        await this.sendSignal("peer-ready", {}); clearInterval(this.readyInterval);
        this.readyInterval = setInterval(() => this.sendSignal("peer-ready", {}), 1200);
      }
      if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status) && !this.closed) {
        this.realtimeSubscribed = false; clearTimeout(this.realtimeErrorTimer);
        // Supabase Realtime reconnects channels automatically. Give it a short
        // recovery window, and do not tear down healthy peer media mid-round.
        this.realtimeErrorTimer = setTimeout(() => {
          if (!this.realtimeSubscribed && this.pc?.connectionState !== "connected" && !this.closed) {
            this.onFailure?.(new Error("Realtime signaling disconnected"));
          }
        }, 5000);
      }
    });
    this.connectionTimer = setTimeout(() => { if (!this.closed && this.pc?.connectionState !== "connected") this.onFailure?.(new Error("WebRTC connection timed out")); }, 18000);
  }

  createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 }); this.pc = pc;
    this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.sendSignal("ice-candidate", { candidate: candidate.toJSON() }); };
    pc.ontrack = ({ streams }) => { if (streams[0]) this.onRemoteStream?.(streams[0]); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { clearTimeout(this.connectionTimer); clearInterval(this.readyInterval); }
      if (["failed", "closed"].includes(pc.connectionState) && !this.closed) this.onFailure?.(new Error(`Peer connection ${pc.connectionState}`));
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed" && !this.closed) pc.restartIce?.(); };
  }

  async sendSignal(type, data) {
    if (!this.channel || this.closed) return;
    return this.channel.send({ type: "broadcast", event: "signal", payload: { type, sender: this.clientId, ...data } }).catch(() => {});
  }

  async broadcast(type, data = {}) {
    if (!this.channel || this.closed) return;
    return this.channel.send({ type: "broadcast", event: "match-event", payload: { type, sender: this.clientId, ...data } });
  }

  async handleSignal(message) {
    if (!message || message.sender === this.clientId || this.closed) return;
    try {
      if (message.type === "peer-ready") {
        this.remoteReady = true;
        if (this.isPlayerA && !this.offerSent) { this.offerSent = true; const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer); await this.sendSignal("offer", { sdp: this.pc.localDescription }); }
      } else if (message.type === "offer" && !this.isPlayerA) {
        await this.pc.setRemoteDescription(message.sdp); await this.flushIce();
        const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer); await this.sendSignal("answer", { sdp: this.pc.localDescription });
      } else if (message.type === "answer" && this.isPlayerA) {
        await this.pc.setRemoteDescription(message.sdp); await this.flushIce();
      } else if (message.type === "ice-candidate" && message.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate); else this.pendingIce.push(message.candidate);
      } else if (message.type === "opponent-left") this.onOpponentLeft?.();
    } catch (error) { this.onFailure?.(error); }
  }

  async flushIce() { for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate); }
  async close({ notify = false } = {}) {
    if (this.closed) return; if (notify) await this.sendSignal("opponent-left", {});
    this.closed = true; clearInterval(this.readyInterval); clearTimeout(this.connectionTimer);
    clearTimeout(this.realtimeErrorTimer);
    if (this.pc) { this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.close(); this.pc = null; }
    if (this.channel) { await this.supabase.removeChannel(this.channel).catch(() => {}); this.channel = null; }
  }
}
