import { EventEmitter } from 'node:events';
import type { WasmEngine } from './wasm-engine.js';
import { CallState, type AudioInputSource, type CallOptions } from './types.js';

export { CallState };
export type { AudioConfig, AudioInputSource, CallEvents, CallOptions, RelayListUpdate, VoipSdkConfig } from './types.js';

export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    readonly engine: WasmEngine;
    _audioSource: AudioInputSource;
    _audioLoop: boolean;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    _updateState: (state: number) => void;
    _emitAudio: (pcm: Float32Array) => void;
    _forceEnd: (reason: string) => void;
}

export type VoipClientConfig = {
    /** Socket Baileys yang sudah ada (alternatif dari connectWithSocket). */
    sock?: any;
    resourcesPath?: string;
    wasmPath?: string;
    enableLogs?: boolean;
    /** Tolak otomatis panggilan masuk (panggilan keluar yang aktif tidak terpengaruh). */
    autoRejectIncoming?: boolean;
};

export declare class VoipClient {
    #private;
    constructor(config?: VoipClientConfig);
    isInitialized: () => boolean;
    getActiveCall: () => ActiveCall | null;
    getSocket: () => any;
    connectWithSocket: (sock: any) => Promise<void>;
    connect: () => Promise<void>;
    /** `to` bisa nomor (digit), JID `@s.whatsapp.net`, atau LID `@lid`. */
    call: (target: string | CallOptions, opts?: Omit<CallOptions, 'to'>) => Promise<ActiveCall>;
    endCall: (reason?: string) => void;
    mute: (muted?: boolean) => void;
    disconnect: () => void;
}
