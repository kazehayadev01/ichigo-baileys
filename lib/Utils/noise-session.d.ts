import type { Logger } from 'pino';
export declare const NOISE_XX_NAME: Buffer;
export declare const NOISE_IK_NAME: Buffer;
export declare const NOISE_XX_FALLBACK_NAME: Buffer;
export type NoiseRootCa = { publicKey: Uint8Array; serial: number };
export type NoiseKeyPair = { private: Uint8Array; public: Uint8Array };
export declare class NoiseHandshake {
    start(protocolName: Uint8Array, prologue: Uint8Array): void;
    authenticate(data: Uint8Array): void;
    mixIntoKey(material: Uint8Array): void;
    encrypt(plaintext: Uint8Array): Buffer;
    decrypt(ciphertext: Uint8Array): Buffer;
    finish(): { encKey: Buffer; decKey: Buffer; encrypt(p: Uint8Array): Buffer; decrypt(c: Uint8Array): Buffer };
}
export declare const verifyNoiseCertificateChain: (certificateChain: Uint8Array, serverStatic: Uint8Array, rootCa?: NoiseRootCa) => void;
export declare const makeNoiseSession: (opts: {
    header: Buffer;
    routingInfo?: Buffer;
    sendWire: (bytes: Buffer) => Promise<void>;
    logger: Logger;
    handshakeTimeoutMs?: number;
}) => {
    start(args: {
        clientStaticKeyPair: NoiseKeyPair;
        ephemeralKeyPair: NoiseKeyPair;
        payload: Uint8Array;
        serverStaticKey?: Uint8Array;
        verifyCertificates?: boolean;
        trustedRootCa?: NoiseRootCa;
    }): Promise<{ mode: 'xx' | 'ik' | 'xx-fallback'; serverStaticKey: Buffer | null; early: Buffer[] }>;
    pushWire(chunk: Buffer): Buffer[];
    onClosed(error?: Error): void;
    encodeFrame(data: Uint8Array): Buffer;
    decodeFrame(newData: Buffer, onFrame: (frame: any) => void): Promise<void>;
    readonly serverStaticKey: Buffer | null;
};
