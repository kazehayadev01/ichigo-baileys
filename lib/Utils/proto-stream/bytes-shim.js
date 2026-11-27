export const EMPTY_BYTES = Object.freeze(new Uint8Array(0));
const TEXT_ENCODER = new TextEncoder();
export function toChunkBytes(chunk) {
    if (typeof chunk === 'string')
        return TEXT_ENCODER.encode(chunk);
    if (chunk instanceof Uint8Array)
        return chunk;
    if (chunk instanceof ArrayBuffer)
        return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk))
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    throw new Error(`unsupported stream chunk type: ${typeof chunk}`);
}
