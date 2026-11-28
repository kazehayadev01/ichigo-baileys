/**
 * Noise session ported from zapo-js (MIT): src/transport/noise/*.
 * Adds, compared to noise-handler.js:
 *  - IK "resume" handshake when the server static key from a previous
 *    connection is known (one fewer round of certificate work), with the
 *    automatic XXfallback when the server answers with its static key;
 *  - strict certificate chain check (leaf key must equal the server static);
 *  - configurable trusted root CA.
 *
 * Nothing here touches persisted auth state. The only persisted input is the
 * existing `creds.noiseKey`; the optional `creds.serverStaticKey` is purely
 * additive (absent => full XX handshake, exactly like before).
 *
 * Exposes the same `encodeFrame` / `decodeFrame(data, onFrame)` surface as
 * makeNoiseHandler so the socket loop does not change after the handshake.
 */
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto.js';
const EMPTY = Buffer.alloc(0);
export const NOISE_XX_NAME = Buffer.from('Noise_XX_25519_AESGCM_SHA256\0\0\0\0');
export const NOISE_IK_NAME = Buffer.from('Noise_IK_25519_AESGCM_SHA256\0\0\0\0');
export const NOISE_XX_FALLBACK_NAME = Buffer.from('Noise_XXfallback_25519_AESGCM_SHA256');
const nonce = (counter) => {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(counter >>> 0, 8);
    return iv;
};
const fail = (message) => new Boom(message, { statusCode: 400 });
export class NoiseHandshake {
    start(protocolName, prologue) {
        const h = protocolName.length === 32 ? Buffer.from(protocolName) : sha256(protocolName);
        this.hash = h;
        this.chainingKey = h;
        this.cipherKey = h;
        this.counter = 0;
        this.authenticate(prologue);
    }
    authenticate(data) {
        this.hash = sha256(Buffer.concat([this.hash, data]));
    }
    mixIntoKey(material) {
        this.counter = 0;
        const out = hkdf(Buffer.from(material), 64, { salt: this.chainingKey, info: '' });
        this.chainingKey = out.subarray(0, 32);
        this.cipherKey = out.subarray(32);
    }
    encrypt(plaintext) {
        const out = aesEncryptGCM(plaintext, this.cipherKey, nonce(this.counter++), this.hash);
        this.authenticate(out);
        return out;
    }
    decrypt(ciphertext) {
        const out = aesDecryptGCM(ciphertext, this.cipherKey, nonce(this.counter++), this.hash);
        this.authenticate(ciphertext);
        return out;
    }
    finish() {
        const out = hkdf(EMPTY, 64, { salt: this.chainingKey, info: '' });
        return new TransportState(out.subarray(0, 32), out.subarray(32));
    }
}
class TransportState {
    constructor(encKey, decKey) {
        this.encKey = encKey;
        this.decKey = decKey;
        this.readCounter = 0;
        this.writeCounter = 0;
    }
    encrypt(plaintext) {
        return aesEncryptGCM(plaintext, this.encKey, nonce(this.writeCounter++), EMPTY);
    }
    decrypt(ciphertext) {
        return aesDecryptGCM(ciphertext, this.decKey, nonce(this.readCounter++), EMPTY);
    }
}
const parseCert = (cert, label) => {
    if (!cert?.details || !cert?.signature) {
        throw fail(`invalid noise ${label} certificate`);
    }
    if (cert.signature.length !== 64) {
        throw fail(`invalid noise ${label} certificate signature size`);
    }
    const details = proto.CertChain.NoiseCertificate.Details.decode(cert.details);
    return {
        serial: Number(details.serial ?? 0),
        issuerSerial: Number(details.issuerSerial ?? 0),
        key: Buffer.from(details.key ?? EMPTY),
        details: cert.details,
        signature: cert.signature
    };
};
/** Strict verification, same checks as zapo's verifyNoiseCertificateChain. */
export const verifyNoiseCertificateChain = (certificateChain, serverStatic, rootCa = { publicKey: WA_CERT_DETAILS.PUBLIC_KEY, serial: WA_CERT_DETAILS.SERIAL }) => {
    const chain = proto.CertChain.decode(certificateChain);
    if (!chain.leaf || !chain.intermediate) {
        throw fail('noise certificate chain is missing leaf/intermediate');
    }
    const intermediate = parseCert(chain.intermediate, 'intermediate');
    if (intermediate.issuerSerial !== rootCa.serial) {
        throw fail('certification match failed');
    }
    if (!Curve.verify(rootCa.publicKey, intermediate.details, intermediate.signature)) {
        throw fail('noise intermediate certificate signature invalid');
    }
    const leaf = parseCert(chain.leaf, 'leaf');
    if (leaf.issuerSerial !== intermediate.serial) {
        throw fail('noise leaf certificate issuer mismatch');
    }
    if (!Curve.verify(intermediate.key, leaf.details, leaf.signature)) {
        throw fail('noise certificate signature invalid');
    }
    if (!leaf.key.equals(Buffer.from(serverStatic))) {
        throw fail('noise leaf certificate key mismatch with server static key');
    }
};
const buildIntro = (header, routingInfo) => {
    if (!routingInfo) {
        return Buffer.from(header);
    }
    const intro = Buffer.alloc(7 + routingInfo.byteLength + header.length);
    intro.write('ED', 0, 'utf8');
    intro.writeUint8(0, 2);
    intro.writeUint8(1, 3);
    intro.writeUint8(routingInfo.byteLength >> 16, 4);
    intro.writeUint16BE(routingInfo.byteLength & 65535, 5);
    intro.set(routingInfo, 7);
    intro.set(header, 7 + routingInfo.byteLength);
    return intro;
};
/**
 * @param {object} opts
 * @param {Buffer} opts.header          NOISE_WA_HEADER
 * @param {Buffer} [opts.routingInfo]
 * @param {(bytes: Buffer) => Promise<void>} opts.sendWire  writes raw bytes to the websocket
 * @param {number} [opts.handshakeTimeoutMs]
 */
export const makeNoiseSession = ({ header, routingInfo, sendWire, logger, handshakeTimeoutMs = 20000 }) => {
    logger = logger.child({ class: 'ns2' });
    const intro = buildIntro(header, routingInfo);
    let sentIntro = false;
    let inBytes = Buffer.alloc(0);
    let transport = null;
    let serverStaticKey = null;
    let closedError = null;
    const inbox = [];
    let waiter = null;
    const takeFrames = () => {
        const frames = [];
        while (inBytes.length >= 3) {
            const size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2];
            if (inBytes.length < size + 3) {
                break;
            }
            frames.push(inBytes.subarray(3, size + 3));
            inBytes = inBytes.subarray(size + 3);
        }
        return frames;
    };
    const wrap = (data) => {
        const size = data.byteLength;
        const prefix = sentIntro ? 0 : intro.length;
        const out = Buffer.allocUnsafe(prefix + 3 + size);
        if (!sentIntro) {
            out.set(intro);
            sentIntro = true;
        }
        out[prefix] = (size >>> 16) & 0xff;
        out[prefix + 1] = (size >>> 8) & 0xff;
        out[prefix + 2] = size & 0xff;
        out.set(data, prefix + 3);
        return out;
    };
    const sendHandshake = (bytes) => sendWire(wrap(bytes));
    const nextHandshakeFrame = () => {
        if (closedError) {
            return Promise.reject(closedError);
        }
        if (inbox.length) {
            return Promise.resolve(inbox.shift());
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiter = null;
                reject(new Boom(`noise handshake frame timeout after ${handshakeTimeoutMs}ms`, { statusCode: 408 }));
            }, handshakeTimeoutMs);
            timer.unref?.();
            waiter = { resolve: f => { clearTimeout(timer); resolve(f); }, reject: e => { clearTimeout(timer); reject(e); } };
        });
    };
    /** feed raw websocket bytes; returns decrypted frames once the transport is up */
    const pushWire = (chunk) => {
        inBytes = inBytes.length ? Buffer.concat([inBytes, chunk]) : Buffer.from(chunk);
        const frames = takeFrames();
        if (!transport) {
            for (const f of frames) {
                if (waiter) {
                    const w = waiter;
                    waiter = null;
                    w.resolve(f);
                }
                else {
                    inbox.push(f);
                }
            }
            return [];
        }
        return frames.map(f => transport.decrypt(f));
    };
    const fullFromServerHello = async (hs, serverHelloFrame, clientStatic, ephemeral, payload, verify, trustedRootCa) => {
        const { serverHello } = proto.HandshakeMessage.decode(serverHelloFrame);
        if (!serverHello?.ephemeral || !serverHello.static || !serverHello.payload) {
            throw fail('noise full handshake missing server hello fields');
        }
        hs.authenticate(serverHello.ephemeral);
        hs.mixIntoKey(Curve.sharedKey(ephemeral.private, serverHello.ephemeral));
        const serverStatic = hs.decrypt(serverHello.static);
        hs.mixIntoKey(Curve.sharedKey(ephemeral.private, serverStatic));
        const cert = hs.decrypt(serverHello.payload);
        if (verify) {
            verifyNoiseCertificateChain(cert, serverStatic, trustedRootCa);
        }
        serverStaticKey = Buffer.from(serverStatic);
        const encStatic = hs.encrypt(clientStatic.public);
        hs.mixIntoKey(Curve.sharedKey(clientStatic.private, serverHello.ephemeral));
        const encPayload = hs.encrypt(payload);
        await sendHandshake(proto.HandshakeMessage.encode({ clientFinish: { static: encStatic, payload: encPayload } }).finish());
        return hs.finish();
    };
    const tryResume = async (serverStatic, clientStatic, ephemeral, payload) => {
        const hs = new NoiseHandshake();
        hs.start(NOISE_IK_NAME, header);
        hs.authenticate(serverStatic);
        hs.authenticate(ephemeral.public);
        hs.mixIntoKey(Curve.sharedKey(ephemeral.private, serverStatic));
        const encStatic = hs.encrypt(clientStatic.public);
        hs.mixIntoKey(Curve.sharedKey(clientStatic.private, serverStatic));
        const encPayload = hs.encrypt(payload);
        await sendHandshake(proto.HandshakeMessage.encode({
            clientHello: { ephemeral: ephemeral.public, payload: encPayload, static: encStatic }
        }).finish());
        const frame = await nextHandshakeFrame();
        const { serverHello } = proto.HandshakeMessage.decode(frame);
        if (!serverHello) {
            throw fail('noise resume handshake missing serverHello');
        }
        if (serverHello.static) {
            return { transport: null, frame };
        }
        if (!serverHello.ephemeral || !serverHello.payload) {
            throw fail('noise resume handshake incomplete serverHello');
        }
        hs.authenticate(serverHello.ephemeral);
        hs.mixIntoKey(Curve.sharedKey(ephemeral.private, serverHello.ephemeral));
        hs.mixIntoKey(Curve.sharedKey(clientStatic.private, serverHello.ephemeral));
        hs.decrypt(serverHello.payload);
        serverStaticKey = Buffer.from(serverStatic);
        return { transport: hs.finish(), frame: null };
    };
    return {
        /**
         * Runs the full handshake. `payload` is the encoded ClientPayload (login or registration).
         * Resolves with `{ mode: 'xx' | 'ik' | 'xx-fallback', serverStaticKey }`.
         */
        async start({ clientStaticKeyPair, ephemeralKeyPair, payload, serverStaticKey: resumeKey, verifyCertificates = true, trustedRootCa }) {
            let mode = 'xx';
            if (resumeKey && resumeKey.length === 32) {
                const res = await tryResume(resumeKey, clientStaticKeyPair, ephemeralKeyPair, payload);
                if (res.transport) {
                    transport = res.transport;
                    mode = 'ik';
                }
                else {
                    const fb = new NoiseHandshake();
                    fb.start(NOISE_XX_FALLBACK_NAME, header);
                    fb.authenticate(ephemeralKeyPair.public);
                    transport = await fullFromServerHello(fb, res.frame, clientStaticKeyPair, ephemeralKeyPair, payload, verifyCertificates, trustedRootCa);
                    mode = 'xx-fallback';
                }
            }
            else {
                const hs = new NoiseHandshake();
                hs.start(NOISE_XX_NAME, header);
                hs.authenticate(ephemeralKeyPair.public);
                await sendHandshake(proto.HandshakeMessage.encode({ clientHello: { ephemeral: ephemeralKeyPair.public } }).finish());
                const frame = await nextHandshakeFrame();
                transport = await fullFromServerHello(hs, frame, clientStaticKeyPair, ephemeralKeyPair, payload, verifyCertificates, trustedRootCa);
            }
            // frames that arrived right behind the server hello belong to the transport
            const early = inbox.splice(0).map(f => transport.decrypt(f));
            logger.trace({ mode }, 'noise session established');
            return { mode, serverStaticKey, early };
        },
        pushWire,
        onClosed(error) {
            closedError = error || new Boom('noise session socket closed', { statusCode: 428 });
            if (waiter) {
                const w = waiter;
                waiter = null;
                w.reject(closedError);
            }
        },
        encodeFrame: (data) => wrap(transport ? transport.encrypt(data) : data),
        /** drop-in for makeNoiseHandler().decodeFrame once the transport is up */
        async decodeFrame(newData, onFrame) {
            for (const raw of pushWire(newData)) {
                onFrame(await decodeBinaryNode(raw));
            }
        },
        get serverStaticKey() {
            return serverStaticKey;
        }
    };
};
