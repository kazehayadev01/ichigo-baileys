export interface NativeCryptoModule {
    readonly x25519ScalarMult?: (privateKey: Uint8Array, publicKey: Uint8Array) => Uint8Array;
    readonly xeddsaSign?: (privateKey: Uint8Array, message: Uint8Array) => Uint8Array;
    readonly xeddsaVerify?: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
}
export declare const resolveNativeCryptoBackend: () => NativeCryptoModule | null;
