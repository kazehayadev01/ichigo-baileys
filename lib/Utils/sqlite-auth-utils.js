// Internal helper shared by the SQLite-backed auth state variants
// (use-*-sqljs-auth-state.js / use-*-sqlite-auth-state.js). Not re-exported
// from Utils/index.js — sql.js and better-sqlite3 are optional dependencies,
// so we only try to load them when one of those auth states is actually used.
let sqlJsPromise;
/** lazily init sql.js (WASM SQLite), shared across all sql.js-backed auth states in this process */
export const getSqlJs = async () => {
    if (!sqlJsPromise) {
        sqlJsPromise = (async () => {
            let initSqlJs;
            try {
                ({ default: initSqlJs } = await import('sql.js'));
            }
            catch {
                throw new Error('sql.js is required for useMultiFileSQLJsAuthState / useSingleFileSQLJsAuthState. ' +
                    'Install it with `npm install sql.js`.');
            }
            return initSqlJs();
        })();
    }
    return sqlJsPromise;
};
let betterSqlite3Promise;
/** lazily load better-sqlite3 (native SQLite binding) */
export const getBetterSqlite3 = async () => {
    if (!betterSqlite3Promise) {
        betterSqlite3Promise = (async () => {
            try {
                const mod = await import('better-sqlite3');
                return mod.default;
            }
            catch {
                throw new Error('better-sqlite3 is required for useMultiFileSQLiteAuthState / useSingleFileSQLiteAuthState. ' +
                    'Install it with `npm install better-sqlite3`.');
            }
        })();
    }
    return betterSqlite3Promise;
};
/** CREATE TABLE used by the "one db per key" variants — single row, id is always 1 */
export const SINGLE_ROW_SCHEMA = 'CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT)';
/** CREATE TABLE used by the "one db for everything" variants — one row per creds/key entry */
export const KV_SCHEMA = 'CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, value TEXT)';

/**
 * pragma yang aman & hemat RAM untuk better-sqlite3.
 * `wal: true` untuk satu file besar (single-file); per-key file (multi-file) cukup mode default
 * supaya tidak membuat file -wal/-shm tambahan untuk tiap key.
 */
export const applySqlitePragmas = (db, { wal = false } = {}) => {
    const run = (sql) => { try { db.pragma(sql); } catch { } };
    run('busy_timeout = 3000');
    run('mmap_size = 0');
    run('temp_store = FILE');
    run('soft_heap_limit = 8388608');
    if (wal) {
        run('journal_mode = WAL');
        run('synchronous = NORMAL');
        run('cache_size = -2000');
        run('journal_size_limit = 4194304');
        run('wal_autocheckpoint = 500');
    }
    else {
        run('cache_size = -64');
    }
};
