import type { AudioInputSource } from './types.js';

export declare class AudioFeeder {
    #private;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: AudioInputSource, loop?: boolean);
    start: () => void;
    stop: () => void;
}
