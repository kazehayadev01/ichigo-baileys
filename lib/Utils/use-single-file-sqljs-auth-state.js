import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { writeFileAtomic, makeCoalescedWriter } from './atomic-write.js';
import { BufferJSON } from './generics.js';
import { getSqlJs, KV_SCHEMA } from './sqlite-auth-utils.js';
const keyName = (type, id) => `${type}:${id}`;
const getValue = (db, key) => {
    const stmt = db.prepare('SELECT value FROM auth WHERE key = :key');
    stmt.bind({ ':key': key });
    let value = null;
    if (stmt.step()) {
        value = stmt.getAsObject().value ?? null;
    }
    stmt.free();
    return value;
};
/**
 * stores the full authentication state (creds + all signal keys) in a single
 * WASM SQLite (sql.js) database file. Same one-file-for-everything shape as
 * useSingleFileAuthState, but backed by SQLite (one row per key) instead of a
 * single giant JSON blob — cheaper per-write since only the changed row(s) are
 * touched, no native build dependency required.
 *
 * Requires the optional `sql.js` package (`npm install sql.js`).
 * */
export const useSingleFileSQLJsAuthState = async (filePath) => {
    const SQL = await getSqlJs();
    let buffer;
    try {
        buffer = await readFile(filePath);
    }
    catch {
        buffer = undefined;
    }
    const db = new SQL.Database(buffer);
    db.run(KV_SCHEMA);
    // db.export() menyalin seluruh database; sebelumnya dipanggil + ditulis untuk SETIAP
    // key. Sekarang perubahan dikumpulkan lalu disimpan sekali per keys.set (digabung &
    // atomik).
    const persist = makeCoalescedWriter(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFileAtomic(filePath, Buffer.from(db.export()));
    });
    const setValue = (key, value) => {
        db.run('INSERT INTO auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    };
    const deleteValue = (key) => {
        db.run('DELETE FROM auth WHERE key = ?', [key]);
    };
    const existingCreds = getValue(db, 'creds');
    const creds = existingCreds ? JSON.parse(existingCreds, BufferJSON.reviver) : initAuthCreds();
    if (!existingCreds) {
        setValue('creds', JSON.stringify(creds, BufferJSON.replacer));
        await persist();
    }
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const raw = getValue(db, keyName(type, id));
                        let value = raw ? JSON.parse(raw, BufferJSON.reviver) : undefined;
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = keyName(category, id);
                            if (value) {
                                setValue(key, JSON.stringify(value, BufferJSON.replacer));
                            }
                            else {
                                deleteValue(key);
                            }
                        }
                    }
                    await persist();
                }
            }
        },
        saveCreds: async () => {
            setValue('creds', JSON.stringify(creds, BufferJSON.replacer));
            await persist();
        }
    };
};
