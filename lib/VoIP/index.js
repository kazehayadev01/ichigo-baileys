import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";

import { isLidUser, jidDecode } from "../WABinary/index.js";
import { WasmEngine } from "./wasm-engine.js";
import { RelayRtcTransport } from "./relay-transport.js";
import { SignalingBridge } from "./signaling.js";
import { AudioFeeder } from "./audio-feeder.js";
import { CallState } from "./types.js";

export { CallState } from "./types.js";

const SHA256_LEN = 32;

const toBareJid = (jid) => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const normalizeTargetInput = (target) => {
  const raw = String(target ?? "").trim();
  if (!raw) throw new Error("Target phone number or JID is required");
  if (isLidUser(raw)) {
    return { isLid: true, lidJid: toBareJid(raw), pnJid: "" };
  }
  if (raw.includes("@")) {
    const decoded = jidDecode(raw);
    const digits = String(decoded?.user ?? raw.split("@")[0]).replace(/\D/g, "");
    if (!digits) throw new Error(`Invalid target JID: ${raw}`);
    return { isLid: false, lidJid: "", pnJid: `${digits}@s.whatsapp.net` };
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error(`Invalid phone number: ${raw}`);
  return { isLid: false, lidJid: "", pnJid: `${digits}@s.whatsapp.net` };
};

const computeHkdf = (key, salt, info, length) => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data, key) => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

const isCallReceiptNode = (node) => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

export class ActiveCall extends EventEmitter {
  #state = CallState.Idle;
  #endResolver;
  #endPromise;
  #endTimer = null;
  #ended = false;
  _audioSource = "silence";
  _audioLoop = false;

  constructor(callId, engine, durationMs) {
    super();
    this.callId = callId;
    this.engine = engine;
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end("timeout"), durationMs);
      this.#endTimer.unref?.();
    }
  }

  get state() { return this.#state; }

  end = (reason = "hangup") => {
    if (this.#ended) return;
    try { this.engine.endCall(0, true); } catch {}
    this._forceEnd(reason);
  };

  mute = (muted) => {
    try { this.engine.setMute(Boolean(muted)); } catch {}
  };

  waitForEnd = () => this.#endPromise;

  _updateState = (state) => {
    this.#state = state;
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.Active) this.emit("connected");
    else if (state === CallState.Idle || state === CallState.Ending) {
      this._forceEnd("ended");
    }
  };

  _emitAudio = (pcm) => { this.emit("audio", pcm); };

  _forceEnd = (reason) => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

export class VoipClient {
  #config;
  #engine = null;
  #relay = null;
  #signaling = null;
  #sock = null;
  #activeCall = null;
  #initPromise = null;
  #boundWs = null;
  #onCallNode = null;
  #onReceiptNode = null;
  #onCallEvent = null;
  #onConnectionUpdate = null;
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder = null;

  constructor(config = {}) {
    this.#config = config;
    if (config.sock) this.#sock = config.sock;
  }

  isInitialized = () => Boolean(this.#engine?.isInitialized?.());

  getActiveCall = () => this.#activeCall;

  getSocket = () => this.#sock;

  connectWithSocket = async (existingSock) => {
    if (this.#sock && existingSock && this.#sock !== existingSock) {
      // Socket baru (mis. setelah reconnect): bersihkan stack lama dulu.
      this.#teardown();
    }
    this.#sock = existingSock ?? this.#sock;
    if (!this.#sock) throw new Error("A WhatsApp socket is required.");
    await this.#ensureInit();
  };

  // Alias: dipakai kalau socket sudah diberikan lewat `new VoipClient({ sock })`.
  connect = async () => {
    if (!this.#sock) throw new Error("Not connected. Pass a socket via connectWithSocket(sock) or new VoipClient({ sock }).");
    await this.#ensureInit();
  };

  #ensureInit = async () => {
    if (this.isInitialized()) {
      this.#attachListeners();
      return;
    }
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = this.#initVoipStack();
    try {
      await this.#initPromise;
    } finally {
      this.#initPromise = null;
    }
  };

  #initVoipStack = async () => {
    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      resourcesPath: this.#config.resourcesPath,
      wasmPath: this.#config.wasmPath,
      enableLogs: this.#config.enableLogs ?? false,
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling?.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay?.send(data, ip, port) ?? 0,
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState?.creds?.me?.id;
    const selfLidJid = this.#sock.authState?.creds?.me?.lid;
    if (!selfPnJid || !selfLidJid) {
      this.#teardown();
      throw new Error("WhatsApp socket is not authenticated with me.id and me.lid yet");
    }
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#attachListeners();
  };

  #attachListeners = () => {
    const sock = this.#sock;
    const ws = sock?.ws;
    if (!ws || typeof ws.on !== "function" || this.#boundWs === ws) return;
    this.#detachListeners();
    this.#boundWs = ws;

    this.#onCallNode = (node) => {
      if (this.#signaling && this.#engine) {
        this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
      }
    };
    this.#onReceiptNode = (node) => {
      if (!isCallReceiptNode(node)) return;
      if (this.#signaling && this.#engine) {
        this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
      }
    };
    ws.on("CB:call", this.#onCallNode);
    ws.on("CB:receipt", this.#onReceiptNode);

    if (this.#config.autoRejectIncoming && sock.ev?.on) {
      this.#onCallEvent = async (calls) => {
        for (const c of calls) {
          if (c.status !== "offer" || c.id === this.#activeCall?.callId) continue;
          try { await sock.rejectCall(c.id, c.from); } catch {}
        }
      };
      sock.ev.on("call", this.#onCallEvent);
    }

    // Socket ditutup -> bebaskan engine/worker/relay supaya tidak menggantung.
    if (sock.ev?.on) {
      this.#onConnectionUpdate = (update) => {
        if (update?.connection === "close") this.disconnect();
      };
      sock.ev.on("connection.update", this.#onConnectionUpdate);
    }
  };

  #detachListeners = () => {
    const ws = this.#boundWs;
    if (ws && typeof ws.off === "function") {
      if (this.#onCallNode) ws.off("CB:call", this.#onCallNode);
      if (this.#onReceiptNode) ws.off("CB:receipt", this.#onReceiptNode);
    }
    const ev = this.#sock?.ev;
    if (ev?.off) {
      if (this.#onCallEvent) ev.off("call", this.#onCallEvent);
      if (this.#onConnectionUpdate) ev.off("connection.update", this.#onConnectionUpdate);
    }
    this.#boundWs = null;
    this.#onCallNode = null;
    this.#onReceiptNode = null;
    this.#onCallEvent = null;
    this.#onConnectionUpdate = null;
  };

  call = async (targetOrOpts, opts = {}) => {
    const isOptsObject = typeof targetOrOpts === "object" && targetOrOpts !== null;
    const resolvedOpts = isOptsObject ? targetOrOpts : opts;
    const rawTarget = isOptsObject ? targetOrOpts.to : targetOrOpts;

    if (this.#activeCall) throw new Error("A call is already active.");
    if (!this.isInitialized()) {
      if (!this.#sock) throw new Error("Not connected. Call connectWithSocket() first.");
      await this.#ensureInit();
    }

    const parsed = normalizeTargetInput(rawTarget);
    const durationMs = resolvedOpts.durationMs ?? 120_000;
    const audioSource = resolvedOpts.audio ?? resolvedOpts.audioSource ?? "silence";
    const audioLoop = Boolean(resolvedOpts.loop);

    let peerLid = parsed.lidJid;
    let targetPnJid = parsed.pnJid;
    if (parsed.isLid) {
      targetPnJid = (await this.#signaling.resolvePn(peerLid)) || peerLid;
    } else {
      peerLid = await this.#signaling.resolveLid(targetPnJid);
      if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);
    }

    for (const jid of [...new Set([targetPnJid, peerLid].filter(Boolean))]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    // Cek ulang: ada panggilan lain yang sempat mulai selama await di atas.
    if (this.#activeCall) throw new Error("A call is already active.");
    if (!this.#engine) throw new Error("VoIP client was disconnected.");

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    call._audioLoop = audioLoop;
    this.#activeCall = call;

    // Tanpa ini #activeCall tidak pernah dikosongkan setelah panggilan selesai:
    // panggilan berikutnya selalu ditolak "A call is already active" dan
    // ffmpeg/buffer capture ikut menggantung.
    call.once("ended", () => {
      if (this.#activeCall === call) {
        this.#activeCall = null;
        this.#handleAudioCaptureStop();
      }
    });

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  endCall = (reason = "hangup") => { this.#activeCall?.end(reason); };

  mute = (muted = true) => { this.#activeCall?.mute(muted); };

  #teardown = () => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#handleAudioCaptureStop();
    this.#detachListeners();
    try { void this.#relay?.closeAll(); } catch {}
    try { this.#engine?.destroy(); } catch {}
    try { this.#signaling?.destroy(); } catch {}
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
  };

  disconnect = () => {
    this.#teardown();
    this.#sock = null;
  };

  #handleCallEvent = (eventType, eventData) => {
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData);
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2) {
      this.#activeCall?._forceEnd("remote_end");
    }
  };

  #handleAudioCaptureInit = (config) => {
    if (!this.#engine) return;
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    if (this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
    }
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = () => {
    if (!this.#engine || !this.#capturePtr) return;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    const audioLoop = this.#activeCall?._audioLoop ?? false;
    this.#feeder?.stop();
    this.#feeder = new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
      audioLoop,
    );
    this.#feeder.start();
  };

  #handleAudioCaptureStop = () => {
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
    }
    this.#capturePtr = 0;
  };
}
