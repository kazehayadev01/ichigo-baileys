// MCP server (Model Context Protocol) untuk socket @kaze012/ichigo-baileys.
// Opt-in: tidak dipakai kecuali kamu memanggil makeMcpServer(). Tanpa dependency
// (hanya modul bawaan Node, di-import lazy), tidak menyentuh authState/creds/keys:
// server hanya menerima method publik sock yang disebut di bawah.
import { createHash, timingSafeEqual } from 'node:crypto';

const LATEST_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT = 4000;

class ToolError extends Error {}

const normalizeJid = (input) => {
  if (typeof input !== 'string' || !input.trim()) throw new ToolError('jid/nomor wajib diisi');
  const v = input.trim();
  if (v.includes('@')) {
    if (!/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid|newsletter)$/.test(v)) throw new ToolError(`jid tidak valid: ${v}`);
    return v;
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 15) throw new ToolError(`nomor tidak valid: ${v}`);
  return `${digits}@s.whatsapp.net`;
};

const unwrap = (m) => {
  let c = m;
  for (let i = 0; i < 4 && c; i++) {
    const inner = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message ||
      c.documentWithCaptionMessage?.message || c.editedMessage?.message;
    if (!inner) break;
    c = inner;
  }
  return c || {};
};

const toEntry = (m) => {
  const key = m?.key;
  if (!key?.remoteJid || key.remoteJid === 'status@broadcast' || !m.message) return null;
  const c = unwrap(m.message);
  const type = Object.keys(c).find((k) => k !== 'messageContextInfo') || 'unknown';
  const text = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption ||
    c.videoMessage?.caption || c.documentMessage?.caption || '';
  const ts = Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp ?? 0);
  return {
    id: key.id, chat: key.remoteJid, from: key.participant || key.remoteJid, fromMe: !!key.fromMe,
    timestamp: ts || Math.floor(Date.now() / 1000), pushName: m.pushName || null, type, text: String(text).slice(0, 2000)
  };
};

const str = (description) => ({ type: 'string', description });

/**
 * @param {object} sock socket dari makeWASocket
 * @param {object} [options]
 * @param {boolean} [options.allowSend=false] izinkan tool pengirim pesan (default hanya baca)
 * @param {string[]} [options.allowedJids] kalau diisi, kirim pesan hanya ke jid/nomor ini
 * @param {number} [options.maxSendsPerMinute=10]
 * @param {number} [options.bufferMessages=0] simpan N pesan masuk terakhir (0 = mati, tidak memakan RAM)
 * @param {string[]} [options.tools] batasi tool yang aktif (nama tool)
 * @param {{name?:string,version?:string}} [options.serverInfo]
 */
export const makeMcpServer = (sock, options = {}) => {
  const allowSend = options.allowSend === true;
  const allowedJids = Array.isArray(options.allowedJids) ? new Set(options.allowedJids.map(normalizeJid)) : null;
  const maxSends = Number.isFinite(options.maxSendsPerMinute) ? options.maxSendsPerMinute : 10;
  const bufferSize = Math.max(0, Math.min(1000, options.bufferMessages | 0));
  const serverInfo = { name: '@kaze012/ichigo-baileys', version: '1.0.2', ...(options.serverInfo || {}) };

  let connection = 'unknown';
  const buffer = [];
  const sendTimes = [];
  const listeners = [];
  const listen = (event, fn) => { sock.ev?.on?.(event, fn); listeners.push([event, fn]); };
  listen('connection.update', (u) => { if (u?.connection) connection = u.connection; });
  if (bufferSize > 0) {
    listen('messages.upsert', ({ messages } = {}) => {
      for (const m of messages || []) {
        const e = toEntry(m);
        if (!e) continue;
        buffer.push(e);
        if (buffer.length > bufferSize) buffer.shift();
      }
    });
  }

  const checkSend = (jid) => {
    if (allowedJids && !allowedJids.has(jid)) throw new ToolError('tujuan tidak ada di allowedJids');
    const now = Date.now();
    while (sendTimes.length && now - sendTimes[0] > 60000) sendTimes.shift();
    if (sendTimes.length >= maxSends) throw new ToolError('batas kirim per menit tercapai');
    sendTimes.push(now);
  };

  const defs = [
    {
      name: 'whatsapp_status', title: 'Status koneksi',
      description: 'Status koneksi WhatsApp dan akun yang sedang dipakai (tanpa kunci/credential).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () => ({ connection, user: sock.user ? { id: sock.user.id, lid: sock.user.lid, name: sock.user.name } : null, bufferedMessages: buffer.length, sendEnabled: allowSend })
    },
    {
      name: 'whatsapp_check_numbers', title: 'Cek nomor terdaftar',
      description: 'Cek apakah nomor terdaftar di WhatsApp (maksimal 20 nomor).',
      inputSchema: { type: 'object', properties: { numbers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Nomor dengan kode negara, mis. 628123456789' } }, required: ['numbers'], additionalProperties: false },
      readOnly: true,
      run: async ({ numbers }) => {
        if (!Array.isArray(numbers) || !numbers.length || numbers.length > 20) throw new ToolError('numbers harus array berisi 1-20 nomor');
        const res = await sock.onWhatsApp(...numbers.map(normalizeJid));
        return (res || []).map((r) => ({ jid: r.jid, exists: !!r.exists }));
      }
    },
    {
      name: 'whatsapp_list_groups', title: 'Daftar grup',
      description: 'Daftar grup yang diikuti akun (id, nama, jumlah anggota).',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' } }, additionalProperties: false },
      readOnly: true,
      run: async ({ limit = 50 } = {}) => {
        const all = Object.values((await sock.groupFetchAllParticipating()) || {});
        const n = Math.max(1, Math.min(200, limit | 0 || 50));
        return { total: all.length, groups: all.slice(0, n).map((g) => ({ id: g.id, subject: g.subject, size: g.participants?.length ?? g.size ?? null })) };
      }
    },
    {
      name: 'whatsapp_group_info', title: 'Info grup',
      description: 'Metadata grup: nama, deskripsi, pembuat, pengaturan, dan peserta (maks 256).',
      inputSchema: { type: 'object', properties: { jid: str('JID grup, berakhiran @g.us') }, required: ['jid'], additionalProperties: false },
      readOnly: true,
      run: async ({ jid }) => {
        const id = normalizeJid(jid);
        if (!id.endsWith('@g.us')) throw new ToolError('jid harus berakhiran @g.us');
        const g = await sock.groupMetadata(id);
        return {
          id: g.id, subject: g.subject, owner: g.owner || null, creation: g.creation || null, desc: g.desc || null,
          announce: !!g.announce, restrict: !!g.restrict, size: g.participants?.length ?? null,
          participants: (g.participants || []).slice(0, 256).map((p) => ({ id: p.id, admin: p.admin || null }))
        };
      }
    },
    {
      name: 'whatsapp_profile_picture', title: 'Foto profil',
      description: 'URL foto profil kontak atau grup (null kalau tidak ada / disembunyikan).',
      inputSchema: { type: 'object', properties: { jid: str('JID atau nomor') }, required: ['jid'], additionalProperties: false },
      readOnly: true,
      run: async ({ jid }) => {
        try { return { url: (await sock.profilePictureUrl(normalizeJid(jid), 'preview')) || null }; }
        catch { return { url: null }; }
      }
    },
    {
      name: 'whatsapp_recent_messages', title: 'Pesan masuk terakhir',
      description: 'Pesan masuk terakhir dari buffer di memori (teks saja). Kosong kalau bufferMessages tidak diaktifkan.',
      inputSchema: { type: 'object', properties: { chat: str('Filter JID chat (opsional)'), limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' } }, additionalProperties: false },
      readOnly: true,
      run: async ({ chat, limit = 20 } = {}) => {
        const id = chat ? normalizeJid(chat) : null;
        const rows = (id ? buffer.filter((m) => m.chat === id) : buffer).slice(-Math.max(1, Math.min(100, limit | 0 || 20)));
        return { enabled: bufferSize > 0, messages: rows };
      }
    },
    {
      name: 'whatsapp_send_text', title: 'Kirim teks',
      description: 'Kirim pesan teks ke nomor atau grup. Hanya aktif kalau server dibuat dengan allowSend: true.',
      inputSchema: { type: 'object', properties: { to: str('Nomor atau JID tujuan'), text: { type: 'string', maxLength: MAX_TEXT } }, required: ['to', 'text'], additionalProperties: false },
      readOnly: false, send: true,
      run: async ({ to, text }) => {
        if (typeof text !== 'string' || !text.trim()) throw new ToolError('text wajib diisi');
        if (text.length > MAX_TEXT) throw new ToolError(`text maksimal ${MAX_TEXT} karakter`);
        const jid = normalizeJid(to);
        checkSend(jid);
        const sent = await sock.sendMessage(jid, { text });
        return { ok: true, to: jid, id: sent?.key?.id || null };
      }
    }
  ];

  const enabled = defs.filter((d) => (allowSend || !d.send) && (!options.tools || options.tools.includes(d.name)));
  const byName = new Map(enabled.map((d) => [d.name, d]));
  const listTools = () => enabled.map((d) => ({
    name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema,
    annotations: { readOnlyHint: d.readOnly, destructiveHint: false, openWorldHint: true }
  }));

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  const callTool = async (params) => {
    const def = byName.get(params?.name);
    if (!def) return { error: -32602, message: `tool tidak dikenal: ${params?.name}` };
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return { error: -32602, message: 'arguments harus object' };
    try {
      const data = await def.run(args);
      return { result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } };
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `gagal: ${e?.message || e}`;
      return { result: { content: [{ type: 'text', text: msg }], isError: true } };
    }
  };

  /** Proses satu pesan JSON-RPC. Mengembalikan response, atau null untuk notifikasi. */
  const handle = async (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return fail(msg?.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok(msg.id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } }, serverInfo
        });
      }
      case 'ping': return isNotification ? null : ok(msg.id, {});
      case 'tools/list': return ok(msg.id, { tools: listTools() });
      case 'tools/call': {
        const r = await callTool(msg.params);
        return r.error ? fail(msg.id, r.error, r.message) : ok(msg.id, r.result);
      }
      default:
        if (isNotification || msg.method.startsWith('notifications/')) return null;
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  /** Parse teks JSON (satu pesan atau batch) -> response JSON-able, atau null. */
  const handleRaw = async (text) => {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return fail(null, -32700, 'Parse error'); }
    if (Array.isArray(parsed)) {
      if (!parsed.length) return fail(null, -32600, 'Invalid Request');
      const out = (await Promise.all(parsed.map(handle))).filter(Boolean);
      return out.length ? out : null;
    }
    return handle(parsed);
  };

  /** Transport stdio (newline-delimited JSON). Untuk proses terpisah; stdout dipakai protokol. */
  const serveStdio = async ({ input = process.stdin, output = process.stdout } = {}) => {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      if (!line.trim()) return;
      const res = await handleRaw(line);
      if (res) output.write(JSON.stringify(res) + '\n');
    });
    return { close: () => rl.close() };
  };

  /** Transport HTTP (POST JSON). Token bearer wajib; default hanya 127.0.0.1. */
  const serveHttp = async ({ port = 3333, host = '127.0.0.1', token, path = '/mcp', allowedOrigins = [] } = {}) => {
    if (typeof token !== 'string' || token.length < 16) throw new Error('serveHttp: token minimal 16 karakter wajib diisi');
    const { createServer } = await import('node:http');
    const digest = (s) => createHash('sha256').update(s).digest();
    const want = digest(token);
    const send = (res, status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== path) return send(res, 404, { error: 'not found' });
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'origin not allowed' });
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !timingSafeEqual(digest(m[1]), want)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      const chunks = []; let size = 0; let aborted = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { aborted = true; send(res, 413, { error: 'body too large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (aborted) return;
        const out = await handleRaw(Buffer.concat(chunks).toString('utf8'));
        if (out === null) { res.writeHead(202); res.end(); } else send(res, 200, out);
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };

  const close = () => { for (const [e, fn] of listeners.splice(0)) sock.ev?.off?.(e, fn); };

  return { handle, handleRaw, serveStdio, serveHttp, listTools, close };
};

export default makeMcpServer;
