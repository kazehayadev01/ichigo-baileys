import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';

// Urutan penting: prefix yang lebih panjang harus dicek lebih dulu
// ('sender-key-memory-' sebelum 'sender-key-', dst.).
const KEY_TYPES = [
    'sender-key-memory',
    'app-state-sync-version',
    'app-state-sync-key',
    'identity-key',
    'lid-mapping',
    'device-list',
    'pre-key',
    'sender-key',
    'session',
    'tctoken'
];
const TMP_FILE_RE = /\.tmp-\d+-\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAT_BATCH = 64;

const classify = (name) => {
    if (name === 'creds.json' || name === 'creds.db') return 'creds';
    if (TMP_FILE_RE.test(name)) return 'tmp';
    const isKeyFile = name.endsWith('.json') || name.endsWith('.db');
    if (isKeyFile) {
        for (const type of KEY_TYPES) {
            if (name.startsWith(`${type}-`)) return type;
        }
    }
    return 'other';
};

const scan = async (folder) => {
    const names = await readdir(folder);
    const entries = [];
    for (let i = 0; i < names.length; i += STAT_BATCH) {
        const batch = names.slice(i, i + STAT_BATCH);
        const stats = await Promise.all(batch.map((name) => stat(join(folder, name)).catch(() => null)));
        batch.forEach((name, idx) => {
            const st = stats[idx];
            if (st?.isFile()) entries.push({ name, type: classify(name), size: st.size, mtimeMs: st.mtimeMs });
        });
    }
    return entries;
};

/**
 * Ringkasan isi folder auth state multi-file (jumlah file & ukuran per tipe key).
 * Berguna untuk melihat apa yang bikin session membengkak.
 */
export const getAuthStateStats = async (folder) => {
    const entries = await scan(folder);
    const byType = {};
    let totalBytes = 0;
    for (const e of entries) {
        const slot = (byType[e.type] ??= { files: 0, bytes: 0 });
        slot.files += 1;
        slot.bytes += e.size;
        totalBytes += e.size;
    }
    return { totalFiles: entries.length, totalBytes, byType };
};

/**
 * Bersihkan file auth state yang aman dibuang agar folder session tetap ringan.
 *
 * Default (aman — semuanya dibuat ulang otomatis bila perlu):
 *  - sisa file sementara `*.tmp-<pid>-<ts>` dari penulisan atomik yang terputus (crash/kill) > 10 menit
 *  - `sender-key-memory-*` tidak tersentuh > 7 hari (distribusi sender key diulang otomatis)
 *  - `device-list-*` tidak tersentuh > 7 hari (di-fetch ulang dari server)
 *
 * Opt-in (default mati, karena menghapusnya berarti sesi/kunci dibuat ulang lewat retry):
 *  - `tctokenMaxAgeDays`, `senderKeyMaxAgeDays`, `sessionMaxAgeDays`
 *
 * TIDAK PERNAH dihapus: creds.json, pre-key-*, identity-key-*, app-state-sync-*, lid-mapping-*.
 *
 * Aman dijalankan saat bot hidup karena hanya menyentuh file yang lama tidak ditulis.
 */
export const pruneAuthState = async (folder, options = {}) => {
    const {
        dryRun = false,
        tmpMaxAgeMs = 10 * 60 * 1000,
        senderKeyMemoryMaxAgeDays = 7,
        deviceListMaxAgeDays = 7,
        tctokenMaxAgeDays = 0,
        senderKeyMaxAgeDays = 0,
        sessionMaxAgeDays = 0,
        now = Date.now()
    } = options;

    const maxAgeMs = {
        tmp: tmpMaxAgeMs,
        'sender-key-memory': senderKeyMemoryMaxAgeDays * DAY_MS,
        'device-list': deviceListMaxAgeDays * DAY_MS,
        tctoken: tctokenMaxAgeDays * DAY_MS,
        'sender-key': senderKeyMaxAgeDays * DAY_MS,
        session: sessionMaxAgeDays * DAY_MS
    };

    const entries = await scan(folder);
    const removed = {};
    let freedBytes = 0;
    for (const e of entries) {
        const limit = maxAgeMs[e.type];
        if (!limit || limit <= 0) continue;
        if (now - e.mtimeMs < limit) continue;
        if (!dryRun) {
            try {
                await unlink(join(folder, e.name));
            } catch {
                continue;
            }
        }
        removed[e.type] = (removed[e.type] ?? 0) + 1;
        freedBytes += e.size;
    }
    return { dryRun, removed, removedFiles: Object.values(removed).reduce((a, b) => a + b, 0), freedBytes };
};
