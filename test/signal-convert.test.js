import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    libsignalSessionToRecord, recordToLibsignalSession, decodeSessionRecord, expandMessageKey, senderKeyToRecord, recordToSenderKey,
    parseSignalAddress, formatSignalAddress, parseSenderKeyName, convertSessions
} from '../lib/Signal/convert.js';

// Fixture dibuat dengan library protobuf resmi (Python) dari skema RecordStructure / SenderKeyRecordStructure,
// dan HKDF-nya dari implementasi RFC 5869 mandiri, bukan dari kode yang diuji.
const FX = {"rec": "0ad103080312210501010101010101010101010101010101010101010101010101010101010101011a21050a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a22200b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b2807326b0a21050c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c12200d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d1a24080012200e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e3aa3010a21050f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f1a24080b122010101010101010101010101010101010101010101010101010101010101010102258080312202fed0344e6044a8d0ae26741d3dcf91991c264fcd6b458096616ba6875fc02d41a20a971539aaaf8f4dcad3302aed1802af954eb2555cc0a7faad582cd51dc1dcdf822109e4a12517eda2a3ff236f254d04ea0b74a2708001221051515151515151515151515151515151515151515151515151515151515151515184d50da0f58d2096a2105141414141414141414141414141414141414141414141414141414141414141412a803080312210501010101010101010101010101010101010101010101010101010101010101011a21051e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e22201f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f2807326b0a21052020202020202020202020202020202020202020202020202020202020202020122021212121212121212121212121212121212121212121212121212121212121211a240800122022222222222222222222222222222222222222222222222222222222222222223aa3010a210523232323232323232323232323232323232323232323232323232323232323231a24080b122024242424242424242424242424242424242424242424242424242424242424242258080312202fed0344e6044a8d0ae26741d3dcf91991c264fcd6b458096616ba6875fc02d41a20a971539aaaf8f4dcad3302aed1802af954eb2555cc0a7faad582cd51dc1dcdf822109e4a12517eda2a3ff236f254d04ea0b750ee0f58d2096a21052828282828282828282828282828282828282828282828282828282828282828", "sk": "0a9501086312240805122009090909090909090909090909090909090909090909090909090909090909091a450a21050808080808080808080808080808080808080808080808080808080808080808122007070707070707070707070707070707070707070707070707070707070707072224080312200606060606060606060606060606060606060606060606060606060606060606", "hkdf": "2fed0344e6044a8d0ae26741d3dcf91991c264fcd6b458096616ba6875fc02d4a971539aaaf8f4dcad3302aed1802af954eb2555cc0a7faad582cd51dc1dcdf89e4a12517eda2a3ff236f254d04ea0b7"};
const b = (n, f) => Buffer.alloc(n, f);
const pk = (f) => Buffer.concat([Buffer.from([5]), b(32, f)]);
const s64 = (x) => x.toString('base64');
const ctx = { localRegistrationId: 1234, localIdentityPublic: pk(1) };
const MKSEED = b(32, 0x42);

const entry = (seed, { open, pending }) => ({
    registrationId: 2000 + seed,
    currentRatchet: { ephemeralKeyPair: { pubKey: s64(pk(seed + 2)), privKey: s64(b(32, seed + 3)) }, lastRemoteEphemeralKey: s64(pk(seed + 5)), previousCounter: 7, rootKey: s64(b(32, seed + 1)) },
    indexInfo: { baseKey: s64(pk(seed + 10)), baseKeyType: pending ? 1 : 2, closed: open ? -1 : 1700000000000, used: open ? 2000 : 1000, created: 500, remoteIdentityKey: s64(pk(seed)) },
    _chains: {
        [s64(pk(seed + 5))]: { chainKey: { counter: 10, key: s64(b(32, seed + 6)) }, chainType: 2, messageKeys: { 3: s64(MKSEED) } },
        [s64(pk(seed + 2))]: { chainKey: { counter: -1, key: s64(b(32, seed + 4)) }, chainType: 1, messageKeys: {} }
    },
    ...(pending ? { pendingPreKey: { signedKeyId: 77, baseKey: s64(pk(seed + 11)), preKeyId: 0 } } : {})
});
const record = () => {
    const a = entry(10, { open: true, pending: true }), c = entry(30, { open: false, pending: false });
    return { _sessions: { [a.indexInfo.baseKey]: a, [c.indexInfo.baseKey]: c }, version: 'v1' };
};
const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'messageKeys' ? undefined : v)));

test('session: output matches bytes from the reference protobuf library', () => {
    assert.equal(Buffer.from(libsignalSessionToRecord(record(), ctx)).toString('hex'), FX.rec);
});
test('session: message key expansion matches independent HKDF', () => {
    const k = expandMessageKey(MKSEED, 3);
    assert.equal(Buffer.concat([k.cipherKey, k.macKey, k.iv]).toString('hex'), FX.hkdf);
});
test('session: reference bytes decode, index 0 and explicit zero preKeyId are kept', () => {
    const r = decodeSessionRecord(Buffer.from(FX.rec, 'hex'));
    assert.equal(r.currentSession.senderChain.chainKey.index, 0);
    assert.equal(r.currentSession.pendingPreKey.preKeyId, 0);
    assert.equal(r.currentSession.pendingPreKey.signedPreKeyId, 77);
    assert.equal(r.previousSessions.length, 1);
});
test('session: round trip keeps everything except pending message keys', () => {
    const rec = libsignalSessionToRecord(record(), ctx);
    const back = recordToLibsignalSession(rec, 1800000000000);
    const entries = Object.values(back._sessions);
    assert.equal(entries.length, 2);
    assert.equal(entries.filter((e) => e.indexInfo.closed === -1).length, 1);
    const again = libsignalSessionToRecord(back, ctx);
    assert.deepEqual(strip(decodeSessionRecord(again)), strip(decodeSessionRecord(rec)));
    const open = entries.find((e) => e.indexInfo.closed === -1);
    assert.equal(open.pendingPreKey.preKeyId, 0);
    assert.equal(open.currentRatchet.ephemeralKeyPair.privKey, s64(b(32, 13)));
});
test('session: strict validation with readable paths', () => {
    const bad = record(); const e = Object.values(bad._sessions)[0];
    e._chains[Object.keys(e._chains)[0]].chainType = 9;
    assert.throws(() => libsignalSessionToRecord(bad, ctx), /chainType tidak dikenal/);
    const short = record(); Object.values(short._sessions)[0].currentRatchet.rootKey = s64(b(10, 1));
    assert.throws(() => libsignalSessionToRecord(short, ctx), /rootKey: panjang 10/);
    assert.throws(() => libsignalSessionToRecord({}, ctx), /bukan record sesi/);
    assert.throws(() => libsignalSessionToRecord(record(), {}), /registrationId/);
    const closed = record(); for (const v of Object.values(closed._sessions)) v.indexInfo.closed = 5;
    assert.equal(libsignalSessionToRecord(closed, ctx), null);
    const noSend = record(); const f = Object.values(noSend._sessions)[0]; delete f._chains[s64(pk(12))];
    assert.throws(() => libsignalSessionToRecord(noSend, ctx), /tidak ada sending chain/);
});
test('session: convertSessions reports failures without stopping the rest', () => {
    const r = convertSessions({ 'a.0': record(), 'b.0': { nope: 1 }, 'c.0': { _sessions: {}, version: 'v1' } }, ctx);
    assert.deepEqual(Object.keys(r.converted), ['a.0']);
    assert.deepEqual(r.skipped, ['c.0']);
    assert.equal(r.failed[0].id, 'b.0');
});

const skStored = (pub) => Buffer.from(JSON.stringify([{ senderKeyId: 99, senderChainKey: { iteration: 5, seed: { type: 'Buffer', data: s64(b(32, 9)) } },
    senderSigningKey: { public: { type: 'Buffer', data: s64(pub) }, private: { type: 'Buffer', data: s64(b(32, 7)) } },
    senderMessageKeys: [{ iteration: 3, seed: { type: 'Buffer', data: s64(b(32, 6)) } }] }]));
test('sender key: matches reference bytes, 32-byte public key is normalised to 33', () => {
    assert.equal(Buffer.from(senderKeyToRecord(skStored(pk(8)))).toString('hex'), FX.sk);
    assert.equal(Buffer.from(senderKeyToRecord(skStored(b(32, 8)))).toString('hex'), FX.sk);
});
test('sender key: only newest state is taken, and the way back reads in this fork format', () => {
    const old = JSON.parse(skStored(pk(8)).toString()); const states = [{ ...old[0], senderKeyId: 1 }, old[0]];
    assert.equal(Buffer.from(senderKeyToRecord(Buffer.from(JSON.stringify(states)))).toString('hex'), FX.sk);
    const back = JSON.parse(recordToSenderKey(Buffer.from(FX.sk, 'hex')).toString('utf-8'), (_, v) => (v?.type === 'Buffer' ? Buffer.from(v.data, 'base64') : v));
    assert.equal(back[0].senderKeyId, 99);
    assert.deepEqual(back[0].senderChainKey.seed, b(32, 9));
    assert.deepEqual(back[0].senderSigningKey.public, pk(8));
    assert.throws(() => senderKeyToRecord(Buffer.from('[]')), /kosong/);
});
test('addresses: signal address and sender key name', () => {
    assert.deepEqual(parseSignalAddress('628123.0'), { user: '628123', server: 's.whatsapp.net', device: 0 });
    assert.deepEqual(parseSignalAddress('1234_1.5'), { user: '1234', server: 'lid', device: 5 });
    for (const id of ['628123.0', '1234_1.5', '99_128.99', '77_129.2']) assert.equal(formatSignalAddress(parseSignalAddress(id)), id);
    assert.deepEqual(parseSenderKeyName('120363@g.us::1234_1::7'), { groupId: '120363@g.us', sender: { user: '1234', server: 'lid', device: 7 } });
    assert.throws(() => parseSignalAddress('abc'), /tidak valid/);
    assert.throws(() => parseSignalAddress('1_5.0'), /domain tidak dikenal/);
});
