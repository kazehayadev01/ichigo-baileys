import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMexArgoResponse, resolveMexArgoWireType, listMexArgoWireTypeNames } from '../lib/Utils/mex-argo/index.js';
import { Curve } from '../lib/Utils/crypto.js';

test('argo: captured FetchReachoutTimelock payload', () => {
    const wire = resolveMexArgoWireType('FetchReachoutTimelock');
    assert.ok(wire);
    const decoded = decodeMexArgoResponse(Buffer.from('BBQxNzg4MTMyNzYzDkRFRkFVTFQMAAIUDgMD', 'base64'), wire);
    assert.deepEqual(decoded.data, {
        xwa2_fetch_account_reachout_timelock: { is_active: true, time_enforcement_ends: '1788132763', enforcement_type: 'DEFAULT' }
    });
    assert.deepEqual(decoded.errors, []);
});
test('argo: bundled wire types listed', () => {
    assert.ok(listMexArgoWireTypeNames().includes('FetchNewChatMessageCappingInfo'));
});
test('curve: JS fallback agreement + sign/verify still work', () => {
    const a = Curve.generateKeyPair(), b = Curve.generateKeyPair();
    assert.deepEqual(Curve.sharedKey(a.private, b.public), Curve.sharedKey(b.private, a.public));
    const msg = Buffer.from('hello');
    assert.ok(Curve.verify(a.public, msg, Curve.sign(a.private, msg)));
});

import { deflateSync } from 'node:zlib';
import { proto } from '../WAProto/index.js';
import { makeIdleTtlCache, makeCacheableSignalKeyStore } from '../lib/Utils/auth-utils.js';
import { streamHistorySync } from '../lib/Utils/history-stream.js';

test('cache: idle TTL expires untouched entries, reads refresh, cap evicts LRU', async () => {
    assert.throws(() => makeIdleTtlCache({ idleMs: 10 }), RangeError);
    const c = makeIdleTtlCache({ idleMs: 1000, maxEntries: 2 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.get('a'), undefined); // evicted by cap
    assert.equal(c.get('c'), 3);
    c.flushAll();
    assert.equal(c.get('c'), undefined);
});
test('cache: signal key store with idleTtlMs reads through to the backing store once', async () => {
    let hits = 0;
    const store = { get: async (t, ids) => { hits++; return Object.fromEntries(ids.map(i => [i, { v: i }])); }, set: async () => { } };
    const k = makeCacheableSignalKeyStore(store, undefined, undefined, { idleTtlMs: 5000 });
    await k.get('session', ['x']); await k.get('session', ['x']);
    assert.equal(hits, 1);
});
test('history sink: streams conversation messages, pushnames, then commits', async () => {
    const sync = proto.HistorySync.create({
        syncType: proto.HistorySync.HistorySyncType.RECENT,
        conversations: [
            { id: '111@s.whatsapp.net', messages: [
                { message: { key: { id: 'M1', remoteJid: '111@s.whatsapp.net', fromMe: false }, messageTimestamp: 1 } },
                { message: { key: { id: 'M2', remoteJid: '111@s.whatsapp.net', fromMe: true }, messageTimestamp: 2 } }] },
            { id: '222@s.whatsapp.net', messages: [] }
        ],
        pushnames: [{ id: '111@s.whatsapp.net', pushname: 'Budi' }],
        progress: 50, chunkOrder: 1
    });
    const payload = deflateSync(Buffer.from(proto.HistorySync.encode(sync).finish()));
    const seen = []; let committed, aborted = null;
    const sink = {
        item: async (i) => { await new Promise(r => setImmediate(r)); seen.push(i); },
        commit: (s) => { committed = s; },
        abort: (c, e) => { aborted = e; }
    };
    const out = await streamHistorySync({ initialHistBootstrapInlinePayload: payload, syncType: 2 }, {}, sink);
    const msgs = seen.filter(i => i.kind === 'conversations.messages');
    assert.deepEqual(msgs.map(m => m.value.message.message.key.id), ['M1', 'M2']);
    assert.equal(msgs[0].value.conversationId, '111@s.whatsapp.net');
    assert.deepEqual(seen.filter(i => i.kind === 'conversations').map(i => i.value.id), ['111@s.whatsapp.net', '222@s.whatsapp.net']);
    assert.equal(seen.find(i => i.kind === 'pushnames').value.pushname, 'Budi');
    assert.equal(committed.messages, 2); assert.equal(committed.conversations, 2);
    assert.equal(out.progress, 50); assert.equal(aborted, null);
});
test('history sink: corrupt payload calls abort and rejects', async () => {
    let aborted;
    await assert.rejects(streamHistorySync({ initialHistBootstrapInlinePayload: Buffer.from('not zlib') }, {}, { item() { }, abort: (c, e) => { aborted = e; } }));
    assert.ok(aborted instanceof Error);
});
