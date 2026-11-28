/**
 * Optional native crypto accelerator (ported from zapo-js, MIT).
 * Resolves `@zapo-js/native` (NAPI addon, then WASM build) once and memoises it.
 * Env `ZAPO_NATIVE_BACKEND`: auto (default) | napi | wasm | js | none.
 * Missing backend stays silent; a present-but-broken one emits a process warning.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WASM_MODULE = '@zapo-js/native/wasm/pkg/zapo_native_wasm.js';
const WASM_BINARY = '@zapo-js/native/wasm/pkg/zapo_native_wasm_bg.wasm';
const isAbsence = (error) => {
    const code = error?.code;
    const message = String(error?.message ?? '');
    return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || message.includes('Cannot find native binding');
};
const warn = (backend, error) => process.emitWarning('failed to load native crypto accelerator, falling back', {
    code: 'ZAPO_NATIVE_LOAD_FAILED',
    detail: `${backend}: ${error?.message ?? error}`
});
const loadWasm = () => {
    const mod = require(WASM_MODULE);
    mod.initSync({ module: readFileSync(require.resolve(WASM_BINARY)) });
    return mod;
};
let cached;
export const resolveNativeCryptoBackend = () => {
    if (cached !== undefined)
        return cached;
    const backend = (process.env.ZAPO_NATIVE_BACKEND ?? 'auto').toLowerCase();
    cached = null;
    if (backend === 'js' || backend === 'none')
        return cached;
    if (backend === 'napi' || backend === 'auto') {
        try { cached = require('@zapo-js/native'); }
        catch (e) { if (!isAbsence(e)) warn('napi', e); }
    }
    if (cached === null && (backend === 'wasm' || backend === 'auto')) {
        try { cached = loadWasm(); }
        catch (e) { if (!isAbsence(e)) warn('wasm', e); }
    }
    return cached;
};
