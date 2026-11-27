// Konverter state Signal: libsignal-node (format yang dipakai fork ini) <-> protobuf
// RecordStructure / SenderKeyRecordStructure (format zapo-js, MIT, vinikjkkj/zapo).
// Fungsi murni: tidak membaca/menulis auth state, tidak ada dependency (hanya node:crypto).
// Hasilnya data baru; kamu sendiri yang memutuskan mau disimpan ke mana.
import { hkdfSync } from 'node:crypto';

// ---- protobuf minimal (hanya wire type 0 dan 2, cukup untuk skema di bawah) ----
const Chain = { senderRatchetKey: [1, 'bytes'], senderRatchetKeyPrivate: [2, 'bytes'], chainKey: [3, 'msg', { index: [1, 'u32'], key: [2, 'bytes'] }], messageKeys: [4, 'msg', { index: [1, 'u32'], cipherKey: [2, 'bytes'], macKey: [3, 'bytes'], iv: [4, 'bytes'] }, true] };
const PendingPreKey = { preKeyId: [1, 'u32'], baseKey: [2, 'bytes'], signedPreKeyId: [3, 'u32'] };
const SessionStructure = {
    sessionVersion: [1, 'u32'], localIdentityPublic: [2, 'bytes'], remoteIdentityPublic: [3, 'bytes'], rootKey: [4, 'bytes'], previousCounter: [5, 'u32'],
    senderChain: [6, 'msg', Chain], receiverChains: [7, 'msg', Chain, true], pendingPreKey: [9, 'msg', PendingPreKey],
    remoteRegistrationId: [10, 'u32'], localRegistrationId: [11, 'u32'], aliceBaseKey: [13, 'bytes']
};
const RecordStructure = { currentSession: [1, 'msg', SessionStructure], previousSessions: [2, 'msg', SessionStructure, true] };
const KeyIter = { iteration: [1, 'u32'], seed: [2, 'bytes'] };
const SenderKeyState = {
    senderKeyId: [1, 'u32'], senderChainKey: [2, 'msg', KeyIter],
    senderSigningKey: [3, 'msg', { public: [1, 'bytes'], private: [2, 'bytes'] }], senderMessageKeys: [4, 'msg', KeyIter, true]
};
const SenderKeyRecordStructure = { senderKeyStates: [1, 'msg', SenderKeyState, true] };

const varint = (out, n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`protobuf: nilai tidak valid ${n}`);
    while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
};
const encode = (schema, obj) => {
    const out = [];
    const fields = Object.entries(schema).sort((a, b) => a[1][0] - b[1][0]);
    for (const [name, [no, type, sub, repeated]] of fields) {
        const rep = type === 'msg' ? repeated : false;
        const schemaSub = type === 'msg' ? sub : undefined;
        const v = obj[name];
        if (v === undefined || v === null) continue;
        for (const item of rep ? v : [v]) {
            if (type === 'u32') { varint(out, no << 3); varint(out, item); continue; }
            const bytes = type === 'msg' ? encode(schemaSub, item) : item;
            if (!(bytes instanceof Uint8Array)) throw new Error(`protobuf: ${name} harus bytes`);
            varint(out, (no << 3) | 2); varint(out, bytes.length);
            for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
        }
    }
    return Uint8Array.from(out);
};
const decode = (schema, buf) => {
    const byNo = new Map(Object.entries(schema).map(([name, d]) => [d[0], [name, ...d.slice(1)]]));
    const out = {};
    let p = 0;
    const rv = () => { let r = 0, m = 1, b; do { if (p >= buf.length) throw new Error('protobuf: data terpotong'); b = buf[p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return r; };
    while (p < buf.length) {
        const tag = rv(), no = Math.floor(tag / 8), wt = tag % 8;
        let val;
        if (wt === 0) val = rv();
        else if (wt === 2) { const n = rv(); if (p + n > buf.length) throw new Error('protobuf: panjang melebihi data'); val = buf.subarray(p, p + n); p += n; }
        else if (wt === 1) { p += 8; continue; } else if (wt === 5) { p += 4; continue; } else throw new Error(`protobuf: wire type ${wt} tidak didukung`);
        const d = byNo.get(no);
        if (!d) continue;
        const [name, type, sub, repeated] = d;
        const v = type === 'msg' ? decode(sub, val) : type === 'bytes' ? Buffer.from(val) : val;
        if (type === 'msg' && repeated) (out[name] ||= []).push(v); else out[name] = v;
    }
    return out;
};
export const encodeSessionRecord = (rec) => encode(RecordStructure, rec);
export const decodeSessionRecord = (buf) => decode(RecordStructure, buf);
export const encodeSenderKeyRecord = (rec) => encode(SenderKeyRecordStructure, rec);
export const decodeSenderKeyRecord = (buf) => decode(SenderKeyRecordStructure, buf);

// ---- helper umum ----
const fail = (path, why) => { throw new Error(`${path}: ${why}`); };
const b64 = (v, len, path) => {
    if (typeof v !== 'string') fail(path, 'harus string base64');
    const b = Buffer.from(v, 'base64');
    if (len && b.length !== len) fail(path, `panjang ${b.length}, seharusnya ${len}`);
    return b;
};
const pub33 = (b, path) => {
    if (b.length === 32) return Buffer.concat([Buffer.from([5]), b]);
    if (b.length === 33 && b[0] === 5) return b;
    return fail(path, `public key tidak valid (panjang ${b.length})`);
};
const MAX_PREVIOUS = 40, MAX_RECV_CHAINS = 5;
const SENDING = 1, RECEIVING = 2;

/** Seed kunci pesan libsignal-node (32 byte) -> cipherKey/macKey/iv gaya Java/zapo. */
export const expandMessageKey = (seed, index) => {
    const o = Buffer.from(hkdfSync('sha256', seed, Buffer.alloc(32), Buffer.from('WhisperMessageKeys'), 80));
    return { index, cipherKey: o.subarray(0, 32), macKey: o.subarray(32, 64), iv: o.subarray(64, 80) };
};

const convertChain = (chain, path) => {
    const key = b64(chain?.chainKey?.key, 32, `${path}.chainKey.key`);
    const counter = chain.chainKey.counter;
    if (!Number.isInteger(counter) || counter < -1) fail(`${path}.chainKey.counter`, 'tidak valid');
    return { key, index: counter + 1 }; // libsignal-node: counter = indeks terakhir dipakai; Java/zapo: indeks berikutnya
};

const sessionEntryToStructure = (entry, ctx, path) => {
    const cur = entry?.currentRatchet, info = entry?.indexInfo, chains = entry?._chains;
    if (!cur || !info || !chains) fail(path, 'bukan entry sesi libsignal-node');
    const ephPub = b64(cur.ephemeralKeyPair?.pubKey, null, `${path}.currentRatchet.ephemeralKeyPair.pubKey`);
    const ephPriv = b64(cur.ephemeralKeyPair?.privKey, 32, `${path}.currentRatchet.ephemeralKeyPair.privKey`);
    const ephPub33 = pub33(ephPub, `${path}.ephemeralKeyPair.pubKey`);
    let sending = null; const receiving = [];
    for (const [k, chain] of Object.entries(chains)) {
        const cp = `${path}._chains[${k.slice(0, 8)}…]`;
        const ratchet = pub33(b64(k, null, `${cp}.key`), cp);
        const { key, index } = convertChain(chain, cp);
        if (chain.chainType === SENDING) {
            if (sending) fail(cp, 'lebih dari satu sending chain');
            sending = { senderRatchetKey: ratchet, senderRatchetKeyPrivate: ephPriv, chainKey: { index, key }, messageKeys: [] };
            if (!ratchet.equals(ephPub33)) fail(cp, 'sending chain tidak cocok dengan ephemeral key sekarang');
        } else if (chain.chainType === RECEIVING) {
            const messageKeys = Object.entries(chain.messageKeys || {}).map(([i, seed]) => expandMessageKey(b64(seed, 32, `${cp}.messageKeys[${i}]`), Number(i)))
                .sort((a, b) => a.index - b.index);
            receiving.push({ senderRatchetKey: ratchet, chainKey: { index, key }, messageKeys });
        } else fail(cp, `chainType tidak dikenal: ${chain.chainType}`);
    }
    if (!sending) fail(path, 'tidak ada sending chain');
    const s = {
        sessionVersion: 3,
        localIdentityPublic: ctx.localIdentityPublic, remoteIdentityPublic: pub33(b64(info.remoteIdentityKey, null, `${path}.indexInfo.remoteIdentityKey`), `${path}.remoteIdentityKey`),
        rootKey: b64(cur.rootKey, 32, `${path}.currentRatchet.rootKey`), previousCounter: cur.previousCounter ?? 0,
        senderChain: sending, receiverChains: receiving.slice(-MAX_RECV_CHAINS),
        remoteRegistrationId: entry.registrationId ?? 0, localRegistrationId: ctx.localRegistrationId,
        aliceBaseKey: pub33(b64(info.baseKey, null, `${path}.indexInfo.baseKey`), `${path}.indexInfo.baseKey`)
    };
    if (entry.pendingPreKey) {
        const p = entry.pendingPreKey;
        s.pendingPreKey = { baseKey: pub33(b64(p.baseKey, null, `${path}.pendingPreKey.baseKey`), `${path}.pendingPreKey.baseKey`), signedPreKeyId: p.signedKeyId };
        if (p.preKeyId !== undefined && p.preKeyId !== null) s.pendingPreKey.preKeyId = p.preKeyId;
    }
    return s;
};

const normalizeCtx = (ctx) => {
    if (!ctx || !Number.isInteger(ctx.localRegistrationId)) throw new Error('ctx.localRegistrationId (creds.registrationId) wajib diisi');
    const id = ctx.localIdentityPublic;
    if (!id) throw new Error('ctx.localIdentityPublic (creds.signedIdentityKey.public) wajib diisi');
    return { localRegistrationId: ctx.localRegistrationId, localIdentityPublic: pub33(Buffer.from(id), 'ctx.localIdentityPublic') };
};

/**
 * Sesi libsignal-node (hasil session.serialize(), isi keys 'session') -> bytes RecordStructure.
 * Mengembalikan null kalau tidak ada sesi terbuka (tidak ada yang perlu dipindah).
 * Melempar Error dengan path kolom kalau struktur tidak sesuai, supaya tidak pernah diam-diam salah.
 */
export const libsignalSessionToRecord = (serialized, ctx) => {
    const c = normalizeCtx(ctx);
    const sessions = serialized?._sessions;
    if (!sessions || typeof sessions !== 'object') throw new Error('bukan record sesi libsignal-node (tidak ada _sessions)');
    const entries = Object.entries(sessions).map(([k, e]) => [k, e]);
    const used = (e) => e?.indexInfo?.used ?? 0;
    const open = entries.filter(([, e]) => e?.indexInfo?.closed === -1).sort((a, b) => used(b[1]) - used(a[1]));
    if (!open.length) return null;
    const closed = entries.filter(([, e]) => e?.indexInfo?.closed !== -1).sort((a, b) => used(b[1]) - used(a[1]));
    const rec = {
        currentSession: sessionEntryToStructure(open[0][1], c, `session[${open[0][0].slice(0, 8)}…]`),
        previousSessions: [...open.slice(1), ...closed].slice(0, MAX_PREVIOUS).map(([k, e]) => sessionEntryToStructure(e, c, `session[${k.slice(0, 8)}…]`))
    };
    return encodeSessionRecord(rec);
};

const structureToEntry = (s, closedAt, used) => {
    const sc = s.senderChain;
    if (!sc?.senderRatchetKey || !sc.senderRatchetKeyPrivate || !sc.chainKey) throw new Error('session: sender chain tidak lengkap');
    const chains = {};
    for (const r of s.receiverChains || []) {
        chains[Buffer.from(r.senderRatchetKey).toString('base64')] = {
            chainKey: { counter: (r.chainKey?.index ?? 0) - 1, key: Buffer.from(r.chainKey.key).toString('base64') },
            chainType: RECEIVING, messageKeys: {} // seed asli tidak bisa dipulihkan dari kunci turunan (HKDF satu arah)
        };
    }
    chains[Buffer.from(sc.senderRatchetKey).toString('base64')] = {
        chainKey: { counter: sc.chainKey.index - 1, key: Buffer.from(sc.chainKey.key).toString('base64') }, chainType: SENDING, messageKeys: {}
    };
    const last = s.receiverChains?.length ? s.receiverChains[s.receiverChains.length - 1].senderRatchetKey : sc.senderRatchetKey;
    const entry = {
        registrationId: s.remoteRegistrationId,
        currentRatchet: {
            ephemeralKeyPair: { pubKey: Buffer.from(sc.senderRatchetKey).toString('base64'), privKey: Buffer.from(sc.senderRatchetKeyPrivate).toString('base64') },
            lastRemoteEphemeralKey: Buffer.from(last).toString('base64'), previousCounter: s.previousCounter ?? 0, rootKey: Buffer.from(s.rootKey).toString('base64')
        },
        indexInfo: {
            baseKey: Buffer.from(s.aliceBaseKey ?? s.remoteIdentityPublic).toString('base64'), baseKeyType: s.pendingPreKey ? 1 : 2,
            closed: closedAt, used, created: used, remoteIdentityKey: Buffer.from(s.remoteIdentityPublic).toString('base64')
        },
        _chains: chains
    };
    if (s.pendingPreKey) {
        entry.pendingPreKey = { signedKeyId: s.pendingPreKey.signedPreKeyId, baseKey: Buffer.from(s.pendingPreKey.baseKey).toString('base64') };
        if (s.pendingPreKey.preKeyId !== undefined) entry.pendingPreKey.preKeyId = s.pendingPreKey.preKeyId;
    }
    return entry;
};

/**
 * bytes RecordStructure -> objek yang cocok disimpan sebagai keys 'session' (format libsignal-node).
 * Kunci pesan yang tertunda (out-of-order) tidak ikut: seed aslinya tidak bisa dibalik dari kunci turunan.
 */
export const recordToLibsignalSession = (bytes, now = Date.now()) => {
    const rec = decodeSessionRecord(Buffer.from(bytes));
    if (!rec.currentSession) throw new Error('record tanpa currentSession');
    const all = [rec.currentSession, ...(rec.previousSessions || [])];
    const _sessions = {};
    all.forEach((s, i) => {
        const e = structureToEntry(s, i === 0 ? -1 : now, now - i); // urutan "used" dijaga lewat timestamp menurun
        _sessions[e.indexInfo.baseKey] = e;
    });
    return { _sessions, version: 'v1' };
};

// ---- sender key ----
const bj = (v) => (v?.type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : Buffer.from(v ?? []));
const reviveBuf = (_, v) => (v && typeof v === 'object' && v.type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : v);
const bjOut = (_, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? { type: 'Buffer', data: Buffer.from(v).toString('base64') } : v);

/**
 * Isi keys 'sender-key' fork ini (bytes JSON array state, atau array state hasil parse) -> bytes SenderKeyRecordStructure.
 * zapo hanya memakai state pertama, jadi diambil state terbaru (terakhir di fork ini); state lama dibuang.
 */
export const senderKeyToRecord = (stored) => {
    const states = Array.isArray(stored) ? stored : JSON.parse(Buffer.from(stored).toString('utf-8'), reviveBuf);
    if (!Array.isArray(states) || !states.length) throw new Error('sender key kosong');
    const st = states[states.length - 1];
    if (!st?.senderChainKey || !st?.senderSigningKey) throw new Error('state sender key tidak lengkap');
    const priv = bj(st.senderSigningKey.private);
    const seed = bj(st.senderChainKey.seed);
    if (seed.length !== 32) throw new Error(`chain key sender key panjang ${seed.length}, seharusnya 32`);
    return encodeSenderKeyRecord({
        senderKeyStates: [{
            senderKeyId: st.senderKeyId, senderChainKey: { iteration: st.senderChainKey.iteration, seed },
            senderSigningKey: { public: pub33(bj(st.senderSigningKey.public), 'senderSigningKey.public'), ...(priv.length ? { private: priv } : {}) },
            senderMessageKeys: (st.senderMessageKeys || []).map((k) => ({ iteration: k.iteration, seed: bj(k.seed) }))
        }]
    });
};

/** bytes SenderKeyRecordStructure -> Buffer JSON siap disimpan sebagai keys 'sender-key' di fork ini. */
export const recordToSenderKey = (bytes) => {
    const rec = decodeSenderKeyRecord(Buffer.from(bytes));
    if (!rec.senderKeyStates?.length) throw new Error('record tanpa senderKeyStates');
    const states = rec.senderKeyStates.map((s) => ({
        senderKeyId: s.senderKeyId, senderChainKey: { iteration: s.senderChainKey.iteration, seed: s.senderChainKey.seed },
        senderSigningKey: { public: s.senderSigningKey.public, private: s.senderSigningKey.private ?? Buffer.alloc(0) },
        senderMessageKeys: (s.senderMessageKeys || []).map((k) => ({ iteration: k.iteration, seed: k.seed }))
    }));
    return Buffer.from(JSON.stringify(states, bjOut), 'utf-8');
};

// ---- alamat ----
const SERVERS = { 0: 's.whatsapp.net', 1: 'lid', 128: 'hosted', 129: 'hosted.lid' };
const DOMAINS = Object.fromEntries(Object.entries(SERVERS).map(([d, s]) => [s, Number(d)]));

/** "628123_1.0" (id sesi fork ini) -> { user, server, device } (gaya SignalAddress zapo). */
export const parseSignalAddress = (id) => {
    const m = /^(.+)\.(\d+)$/.exec(id);
    if (!m) throw new Error(`id sesi tidak valid: ${id}`);
    const [, name, device] = m;
    const u = /^(.+)_(\d+)$/.exec(name);
    const domain = u ? Number(u[2]) : 0;
    if (!(domain in SERVERS)) throw new Error(`domain tidak dikenal: ${domain}`);
    return { user: u ? u[1] : name, server: SERVERS[domain], device: Number(device) };
};
export const formatSignalAddress = ({ user, server, device }) => {
    const d = DOMAINS[server];
    if (d === undefined) throw new Error(`server tidak dikenal: ${server}`);
    return `${d ? `${user}_${d}` : user}.${device}`;
};
/** "group::628123_1::0" (nama sender key fork ini) -> { groupId, sender } */
export const parseSenderKeyName = (name) => {
    const [groupId, user, device] = name.split('::');
    if (!groupId || !user || device === undefined) throw new Error(`nama sender key tidak valid: ${name}`);
    return { groupId, sender: parseSignalAddress(`${user}.${device}`) };
};

/**
 * Konversi massal tanpa menyentuh apa pun: { id: serializedSession } -> { converted: { id: Uint8Array }, skipped: [id], failed: [{id, error}] }.
 * Satu entry rusak tidak menggagalkan yang lain.
 */
export const convertSessions = (sessions, ctx) => {
    const res = { converted: {}, skipped: [], failed: [] };
    normalizeCtx(ctx);
    for (const [id, s] of Object.entries(sessions)) {
        try { const r = libsignalSessionToRecord(s, ctx); if (r) res.converted[id] = r; else res.skipped.push(id); }
        catch (e) { res.failed.push({ id, error: e.message }); }
    }
    return res;
};
