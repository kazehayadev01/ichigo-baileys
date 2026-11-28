import { spawn } from 'node:child_process';

const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
const DEFAULT_WARMUP_MS = 500;

export class AudioFeeder {
    sampleRate;
    channels;
    framesPerChunk;
    onChunk;
    source;
    loop;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #emitTimer = null;
    #nextEmitAtMs = 0;
    #warmupUntilMs = 0;
    droppedChunks = 0;
    underflowChunks = 0;
    bytesProduced = 0;
    chunksEmitted = 0;

    constructor(sampleRate, channels, framesPerChunk, onChunk, source = 'silence', loop = false) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.source = source;
        this.loop = loop;
    }

    start = () => {
        if (this.#proc) return;
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        const isBufferInput = Buffer.isBuffer(this.source) || this.source instanceof Uint8Array;
        const inputArgs = this.#resolveInputArgs(isBufferInput);

        this.#proc = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-thread_queue_size', '512',
            ...inputArgs,
            '-f', 'f32le',
            '-ac', String(this.channels),
            '-ar', String(this.sampleRate),
            'pipe:1'
        ]);

        this.#proc.stdin.on('error', () => {});

        if (isBufferInput) {
            const buf = Buffer.isBuffer(this.source) ? this.source : Buffer.from(this.source);
            this.#proc.stdin.end(buf);
        }

        this.#proc.stdout.on('data', (chunk) => {
            this.#pending = Buffer.concat([this.#pending, chunk]);
            while (this.#pending.length >= chunkBytes) {
                if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
                    this.#proc?.stdout.pause();
                    break;
                }
                const frame = this.#pending.subarray(0, chunkBytes);
                this.#pending = this.#pending.subarray(chunkBytes);
                const out = new Float32Array(chunkSamples);
                out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
                this.bytesProduced += chunkBytes;
                this.#queue.push(out);
            }
        });

        this.#proc.stderr.on('data', () => {});

        this.#proc.on('error', () => {
            this.#proc = null;
        });

        this.#proc.on('exit', () => {
            this.#proc = null;
        });

        this.#nextEmitAtMs = 0;
        this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
    };

    stop = () => {
        if (this.#emitTimer) {
            clearTimeout(this.#emitTimer);
            this.#emitTimer = null;
        }
        try {
            this.#proc?.kill('SIGTERM');
        } catch {}
        this.#proc = null;
        this.#pending = Buffer.alloc(0);
        this.#queue = [];
        this.#warmupUntilMs = 0;
    };

    #resolveInputArgs = (isBufferInput) => {
        if (isBufferInput) {
            return ['-i', 'pipe:0'];
        }
        if (!this.source || this.source === 'silence') {
            return ['-f', 'lavfi', '-i', `aevalsrc=0:d=3600:s=${this.sampleRate}`];
        }
        const src = String(this.source);
        if (src.startsWith('lavfi:')) {
            return ['-f', 'lavfi', '-i', src.slice(6)];
        }
        return this.loop ? ['-stream_loop', '-1', '-i', src] : ['-i', src];
    };

    #scheduleNext = (chunkSamples, chunkIntervalMs) => {
        if (!this.#proc && this.#queue.length === 0) return;
        const now = Date.now();
        if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
        const delayMs = Math.max(0, this.#nextEmitAtMs - now);

        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs && this.#proc) {
                this.#nextEmitAtMs = Date.now() + 10;
                this.#scheduleNext(chunkSamples, chunkIntervalMs);
                return;
            }
            this.#flushOne(chunkSamples);
            this.#nextEmitAtMs += chunkIntervalMs;
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        }, delayMs);
    };

    #flushOne = (chunkSamples) => {
        let nextChunk = this.#queue.shift();
        if (!nextChunk) {
            nextChunk = new Float32Array(chunkSamples);
            this.underflowChunks += 1;
        }
        this.chunksEmitted += 1;
        this.onChunk(nextChunk);
        if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_CHUNKS / 4) {
            this.#proc.stdout.resume();
        }
    };
}
