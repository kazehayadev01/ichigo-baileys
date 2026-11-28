export interface SignalConvertContext {
    /** creds.registrationId */
    localRegistrationId: number;
    /** creds.signedIdentityKey.public (32 atau 33 byte) */
    localIdentityPublic: Uint8Array;
}
export declare const encodeSessionRecord: (rec: object) => Uint8Array;
export declare const decodeSessionRecord: (buf: Uint8Array) => any;
export declare const encodeSenderKeyRecord: (rec: object) => Uint8Array;
export declare const decodeSenderKeyRecord: (buf: Uint8Array) => any;
export declare const expandMessageKey: (seed: Uint8Array, index: number) => { index: number; cipherKey: Buffer; macKey: Buffer; iv: Buffer };
/** Sesi libsignal-node (hasil session.serialize()) -> bytes RecordStructure; null kalau tidak ada sesi terbuka. */
export declare const libsignalSessionToRecord: (serialized: any, ctx: SignalConvertContext) => Uint8Array | null;
/** bytes RecordStructure -> objek 'session' libsignal-node. Kunci pesan tertunda tidak ikut. */
export declare const recordToLibsignalSession: (bytes: Uint8Array, now?: number) => any;
export declare const senderKeyToRecord: (stored: Uint8Array | any[]) => Uint8Array;
export declare const recordToSenderKey: (bytes: Uint8Array) => Buffer;
export declare const parseSignalAddress: (id: string) => { user: string; server: string; device: number };
export declare const formatSignalAddress: (a: { user: string; server: string; device: number }) => string;
export declare const parseSenderKeyName: (name: string) => { groupId: string; sender: { user: string; server: string; device: number } };
export declare const convertSessions: (sessions: Record<string, any>, ctx: SignalConvertContext) => {
    converted: Record<string, Uint8Array>; skipped: string[]; failed: { id: string; error: string }[];
};
