import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuthStateStats, pruneAuthState } from '../lib/Utils/auth-state-maintenance.js';

const DAY = 24 * 60 * 60 * 1000;

const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auth-prune-'));
    const now = Date.now();
    const files = {
        'creds.json': 30,
        'pre-key-1.json': 30,
        'session-628123.0.json': 30,
        'sender-key-120363@g.us--628@s.whatsapp.net--0.json': 30,
        'sender-key-memory-120363@g.us.json': 30,
        'device-list-628123.json': 30,
        'tctoken-628123@lid.json': 30,
        'app-state-sync-key-AAAA.json': 30,
        'lid-mapping-628123.json': 30,
        'session-628999.0.json.tmp-123-1700000000000': 1,
        'sender-key-memory-fresh@g.us.json': 0
    };
    for (const [name, ageDays] of Object.entries(files)) {
        const path = join(dir, name);
        await writeFile(path, '{}');
        const t = new Date(now - ageDays * DAY);
        await utimes(path, t, t);
    }
    return dir;
};

test('getAuthStateStats mengelompokkan per tipe key', async () => {
    const dir = await setup();
    try {
        const stats = await getAuthStateStats(dir);
        assert.equal(stats.totalFiles, 11);
        assert.equal(stats.byType.session.files, 1);
        assert.equal(stats.byType['sender-key'].files, 1);
        assert.equal(stats.byType['sender-key-memory'].files, 2);
        assert.equal(stats.byType.tmp.files, 1);
        assert.equal(stats.byType.creds.files, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('pruneAuthState default hanya membuang file yang aman', async () => {
    const dir = await setup();
    try {
        const res = await pruneAuthState(dir);
        assert.equal(res.removed.tmp, 1);
        assert.equal(res.removed['sender-key-memory'], 1);
        assert.equal(res.removed['device-list'], 1);
        const left = new Set(await readdir(dir));
        for (const keep of ['creds.json', 'pre-key-1.json', 'session-628123.0.json', 'tctoken-628123@lid.json',
            'app-state-sync-key-AAAA.json', 'lid-mapping-628123.json', 'sender-key-memory-fresh@g.us.json']) {
            assert.ok(left.has(keep), `${keep} harus tetap ada`);
        }
        assert.ok(!left.has('device-list-628123.json'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('pruneAuthState dryRun tidak menghapus apa pun', async () => {
    const dir = await setup();
    try {
        const before = (await readdir(dir)).length;
        const res = await pruneAuthState(dir, { dryRun: true, sessionMaxAgeDays: 7 });
        assert.equal(res.dryRun, true);
        assert.ok(res.removed.session >= 1);
        assert.equal((await readdir(dir)).length, before);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
