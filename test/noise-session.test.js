import { test } from 'node:test';
import assert from 'node:assert/strict';
import P from 'pino';
import { proto } from '../WAProto/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Curve, aesDecryptGCM, aesEncryptGCM } from '../lib/Utils/crypto.js';
import { encodeBinaryNode } from '../lib/WABinary/index.js';
import { makeNoiseSession, NoiseHandshake, NOISE_XX_NAME, NOISE_XX_FALLBACK_NAME, verifyNoiseCertificateChain } from '../lib/Utils/noise-session.js';

const logger = P({ level: 'silent' });
const nonce = (c) => { const iv = Buffer.alloc(12); iv.writeUInt32BE(c, 8); return iv; };
const frame = (b) => Buffer.concat([Buffer.from([(b.length >> 16) & 255, (b.length >> 8) & 255, b.length & 255]), b]);

const makeCerts = (serverStatic) => {
    const root = Curve.generateKeyPair(), inter = Curve.generateKeyPair();
    const D = proto.CertChain.NoiseCertificate.Details;
    const iDetails = D.encode({ serial: 1, issuerSerial: 0, key: inter.public }).finish();
    const lDetails = D.encode({ serial: 2, issuerSerial: 1, key: serverStatic.public }).finish();
    const chain = proto.CertChain.encode({
        intermediate: { details: iDetails, signature: Curve.sign(root.private, iDetails) },
        leaf: { details: lDetails, signature: Curve.sign(inter.private, lDetails) }
    }).finish();
    return { root: { publicKey: root.public, serial: 0 }, chain: Buffer.from(chain) };
};

/** Minimal responder. `rejectIk` makes it answer an IK hello with an XXfallback serverHello. */
const makeServer = ({ rejectIk = false, serverStatic, chain }) => {
    let buf = Buffer.alloc(0), gotIntro = false, hs, eS, state = 'hello', t, rx = 0, tx = 0, client;
    const out = { payload: null, mode: null, clientFrames: [] };
    const handle = (raw) => {
        if (state === 'hello') {
            const { clientHello: ch } = proto.HandshakeMessage.decode(raw);
            const fallback = !!(ch.static && ch.payload);
            if (fallback && !rejectIk) throw new Error('test server only models XX and rejected-IK');
            out.mode = fallback ? 'xx-fallback' : 'xx';
            hs = new NoiseHandshake();
            hs.start(fallback ? NOISE_XX_FALLBACK_NAME : NOISE_XX_NAME, NOISE_WA_HEADER);
            hs.authenticate(ch.ephemeral);
            eS = Curve.generateKeyPair();
            hs.authenticate(eS.public);
            hs.mixIntoKey(Curve.sharedKey(eS.private, ch.ephemeral));
            const encStatic = hs.encrypt(serverStatic.public);
            hs.mixIntoKey(Curve.sharedKey(serverStatic.private, ch.ephemeral));
            const encCert = hs.encrypt(chain);
            state = 'finish';
            return frame(Buffer.from(proto.HandshakeMessage.encode({ serverHello: { ephemeral: eS.public, static: encStatic, payload: encCert } }).finish()));
        }
        if (state === 'finish') {
            const { clientFinish: cf } = proto.HandshakeMessage.decode(raw);
            client = hs.decrypt(cf.static);
            hs.mixIntoKey(Curve.sharedKey(eS.private, client));
            out.payload = hs.decrypt(cf.payload);
            const k = hs.finish();
            t = { enc: k.decKey, dec: k.encKey };
            state = 'open';
            return null;
        }
        out.clientFrames.push(aesDecryptGCM(raw, t.dec, nonce(rx++), Buffer.alloc(0)));
        return null;
    };
    out.write = (bytes, reply) => {
        buf = Buffer.concat([buf, bytes]);
        if (!gotIntro) { assert.deepEqual(buf.subarray(0, 4), NOISE_WA_HEADER); buf = buf.subarray(4); gotIntro = true; }
        while (buf.length >= 3) {
            const n = (buf[0] << 16) | (buf[1] << 8) | buf[2];
            if (buf.length < n + 3) break;
            const f = buf.subarray(3, n + 3); buf = buf.subarray(n + 3);
            const r = handle(f);
            if (r) setImmediate(() => reply(r));
        }
    };
    out.sealForClient = (data) => frame(aesEncryptGCM(data, t.enc, nonce(tx++), Buffer.alloc(0)));
    return out;
};

const run = async ({ resume, rejectIk, trustedRootCa, serverStatic = Curve.generateKeyPair(), certsFor }) => {
    const certs = certsFor ?? makeCerts(serverStatic);
    const server = makeServer({ rejectIk, serverStatic, chain: certs.chain });
    let session;
    session = makeNoiseSession({ header: NOISE_WA_HEADER, logger, handshakeTimeoutMs: 1500, sendWire: async (b) => server.write(b, (r) => session.pushWire(r)) });
    const payload = Buffer.from('client-payload');
    const res = await session.start({ clientStaticKeyPair: Curve.generateKeyPair(), ephemeralKeyPair: Curve.generateKeyPair(), payload, serverStaticKey: resume, trustedRootCa: trustedRootCa ?? certs.root });
    return { res, server, session, payload, serverStatic };
};

test('noise: full XX handshake, transport both directions, server static returned', async () => {
    const { res, server, session, payload, serverStatic } = await run({});
    assert.equal(res.mode, 'xx');
    assert.deepEqual(res.serverStaticKey, serverStatic.public);
    assert.deepEqual(server.payload, payload);
    const got = [];
    server.write(session.encodeFrame(Buffer.from('ping')), () => { });
    assert.deepEqual(server.clientFrames.at(-1), Buffer.from('ping'));
    await session.decodeFrame(server.sealForClient(encodeBinaryNode({ tag: 'success', attrs: { t: '1' } })), (n) => got.push(n));
    assert.equal(got[0].tag, 'success');
});
test('noise: IK rejected by server falls back to XXfallback and still completes', async () => {
    const { res, server, payload } = await run({ resume: Buffer.alloc(32, 9), rejectIk: true });
    assert.equal(res.mode, 'xx-fallback');
    assert.equal(server.mode, 'xx-fallback');
    assert.deepEqual(server.payload, payload);
});
test('noise: certificate chain rejects wrong root CA and wrong leaf key', async () => {
    await assert.rejects(run({ trustedRootCa: { publicKey: Curve.generateKeyPair().public, serial: 0 } }), /signature invalid/);
    const real = Curve.generateKeyPair(), other = Curve.generateKeyPair();
    const certs = makeCerts(other); // leaf binds a different key than the one the server presents
    assert.throws(() => verifyNoiseCertificateChain(certs.chain, real.public, certs.root), /leaf certificate key mismatch/);
});
