export type AuthStateStats = {
    totalFiles: number;
    totalBytes: number;
    byType: Record<string, { files: number; bytes: number }>;
};
export type PruneAuthStateOptions = {
    /** Hanya hitung, tidak menghapus. */
    dryRun?: boolean;
    /** Umur minimal file sementara *.tmp-* sebelum dihapus (default 10 menit). */
    tmpMaxAgeMs?: number;
    /** Default 7 hari. 0 = nonaktif. */
    senderKeyMemoryMaxAgeDays?: number;
    /** Default 7 hari. 0 = nonaktif. */
    deviceListMaxAgeDays?: number;
    /** Opt-in, default 0 (nonaktif). */
    tctokenMaxAgeDays?: number;
    /** Opt-in, default 0 (nonaktif). Sender key dibuat ulang lewat retry. */
    senderKeyMaxAgeDays?: number;
    /** Opt-in, default 0 (nonaktif). Sesi dibuat ulang lewat retry. */
    sessionMaxAgeDays?: number;
    now?: number;
};
export type PruneAuthStateResult = {
    dryRun: boolean;
    removed: Record<string, number>;
    removedFiles: number;
    freedBytes: number;
};
export declare const getAuthStateStats: (folder: string) => Promise<AuthStateStats>;
export declare const pruneAuthState: (folder: string, options?: PruneAuthStateOptions) => Promise<PruneAuthStateResult>;
