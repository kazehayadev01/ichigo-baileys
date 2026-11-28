import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeMcpServer } from '../lib/Mcp/index.js';

const makeSock = () => {
  const ev = new EventEmitter();
  const sent = [];
  return {
    ev: { on: (e, f) => ev.on(e, f), off: (e, f) => ev.off(e, f), emit: (e, d) => ev.emit(e, d), count: (e) => ev.listenerCount(e) },
    user: { id: '628111:1@s.whatsapp.net', name: 'Bot' },
    authState: { creds: { secret: 'JANGAN-BOCOR' } },
    sent,
    onWhatsApp: async (...j) => j.map((x) => ({ jid: x, exists: x.startsWith('628') })),
    groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us', subject: 'A', participants: [{ id: 'x' }] } }),
    groupMetadata: async (id) => ({ id, subject: 'A', participants: [{ id: 'x', admin: 'admin' }] }),
    profilePictureUrl: async () => { throw new Error('not-authorized'); },
    sendMessage: async (jid, c) => { sent.push([jid, c]); return { key: { id: 'MSG1' } }; }
  };
};
const rpc = (srv, method, params, id = 1) => srv.handle({ jsonrpc: '2.0', id, method, params });
const call = async (srv, name, args) => (await rpc(srv, 'tools/call', { name, arguments: args })).result;

test('mcp: initialize negotiates protocol, notifications return null', async () => {
  const s = makeMcpServer(makeSock());
  assert.equal((await rpc(s, 'initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
  assert.equal((await rpc(s, 'initialize', { protocolVersion: '1999' })).result.protocolVersion, '2025-06-18');
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await rpc(s, 'nope')).error.code, -32601);
  assert.equal((await s.handle({ foo: 1 })).error.code, -32600);
});

test('mcp: read-only by default, send tool hidden and refused', async () => {
  const sock = makeSock(); const s = makeMcpServer(sock);
  const names = (await rpc(s, 'tools/list')).result.tools.map((t) => t.name);
  assert.ok(names.includes('whatsapp_list_groups') && !names.includes('whatsapp_send_text'));
  assert.equal((await rpc(s, 'tools/call', { name: 'whatsapp_send_text', arguments: { to: '628123456', text: 'hi' } })).error.code, -32602);
  assert.equal(sock.sent.length, 0);
});

test('mcp: send gated by allowedJids and rate limit', async () => {
  const sock = makeSock();
  const s = makeMcpServer(sock, { allowSend: true, allowedJids: ['628123456789'], maxSendsPerMinute: 2 });
  assert.equal((await call(s, 'whatsapp_send_text', { to: '628999999999', text: 'x' })).isError, true);
  assert.equal((await call(s, 'whatsapp_send_text', { to: '628123456789', text: 'a' })).isError, false);
  assert.equal((await call(s, 'whatsapp_send_text', { to: '628123456789', text: 'b' })).isError, false);
  assert.equal((await call(s, 'whatsapp_send_text', { to: '628123456789', text: 'c' })).isError, true);
  assert.deepEqual(sock.sent.map((x) => x[0]), ['628123456789@s.whatsapp.net', '628123456789@s.whatsapp.net']);
});

test('mcp: read tools, and no credential ever appears in output', async () => {
  const s = makeMcpServer(makeSock());
  const all = JSON.stringify([
    await call(s, 'whatsapp_status', {}), await call(s, 'whatsapp_check_numbers', { numbers: ['628123456789', '1555123456'] }),
    await call(s, 'whatsapp_list_groups', {}), await call(s, 'whatsapp_group_info', { jid: 'a@g.us' }),
    await call(s, 'whatsapp_profile_picture', { jid: '628123456789' })
  ]);
  assert.ok(all.includes('628123456789@s.whatsapp.net') && all.includes('a@g.us'));
  assert.ok(!all.includes('JANGAN-BOCOR'));
  assert.equal((await call(s, 'whatsapp_group_info', { jid: '628123456789' })).isError, true);
});

test('mcp: message buffer is opt-in, bounded, and cleaned on close', async () => {
  const sock = makeSock();
  const off = makeMcpServer(sock);
  sock.ev.emit('messages.upsert', { messages: [{ key: { id: '1', remoteJid: 'a@g.us' }, message: { conversation: 'x' } }] });
  assert.equal(JSON.parse((await call(off, 'whatsapp_recent_messages', {})).content[0].text).enabled, false);
  const s = makeMcpServer(sock, { bufferMessages: 2 });
  const mk = (i, chat = 'a@g.us') => ({ key: { id: String(i), remoteJid: chat, participant: 'p@s.whatsapp.net' }, messageTimestamp: 5, message: { ephemeralMessage: { message: { extendedTextMessage: { text: `t${i}` } } } } });
  sock.ev.emit('messages.upsert', { messages: [mk(1), mk(2), mk(3), { key: { id: 's', remoteJid: 'status@broadcast' }, message: { conversation: 'st' } }] });
  const r = JSON.parse((await call(s, 'whatsapp_recent_messages', {})).content[0].text);
  assert.deepEqual(r.messages.map((m) => m.text), ['t2', 't3']);
  s.close(); off.close();
  assert.equal(sock.ev.count('messages.upsert'), 0);
});

test('mcp: http transport needs token, checks origin, supports batch', async () => {
  const s = makeMcpServer(makeSock());
  await assert.rejects(s.serveHttp({ token: 'short' }));
  const tok = 'x'.repeat(24);
  const h = await s.serveHttp({ port: 0, token: tok });
  const url = `http://127.0.0.1:${h.port}/mcp`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({}, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({}, { authorization: `Bearer ${tok}`, origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${tok}` } })).status, 405);
    const auth = { authorization: `Bearer ${tok}` };
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
    const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], auth)).json();
    assert.equal(batch.length, 2);
    assert.equal((await (await post('{bad', auth)).json()).error.code, -32700);
    assert.equal((await post('x'.repeat(300 * 1024), auth).catch(() => ({ status: 413 }))).status, 413);
  } finally { await h.close(); }
});

test('mcp: stdio transport round trip', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(), output = new PassThrough();
  const t = await makeMcpServer(makeSock()).serveStdio({ input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  const line = await new Promise((r) => output.once('data', (d) => r(d.toString())));
  assert.deepEqual(JSON.parse(line), { jsonrpc: '2.0', id: 7, result: {} });
  t.close();
});
