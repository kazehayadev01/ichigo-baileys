import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, makeCoalescedWriter } from '../lib/Utils/atomic-write.js';

test('writeFileAtomic menulis utuh dan tidak meninggalkan file tmp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-'));
    try {
        const target = join(dir, 'creds.json');
        await writeFileAtomic(target, '{"a":1}');
        await writeFileAtomic(target, '{"a":2}');
        assert.equal(await readFile(target, 'utf8'), '{"a":2}');
        assert.deepEqual(await readdir(dir), ['creds.json']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('makeCoalescedWriter menggabungkan permintaan beruntun dan menyimpan state terbaru', async () => {
    let state = 0;
    const written = [];
    const persist = makeCoalescedWriter(async () => {
        const snapshot = state;
        await new Promise((r) => setTimeout(r, 20));
        written.push(snapshot);
    });
    const calls = [];
    for (let i = 1; i <= 10; i++) {
        state = i;
        calls.push(persist());
    }
    await Promise.all(calls);
    assert.ok(written.length <= 2, `harusnya <= 2 penulisan, dapat ${written.length}`);
    assert.equal(written[written.length - 1], 10);
});

test('makeCoalescedWriter bisa dipakai lagi setelah error', async () => {
    let fail = true;
    const persist = makeCoalescedWriter(async () => {
        if (fail) throw new Error('disk penuh');
    });
    await assert.rejects(persist(), /disk penuh/);
    fail = false;
    await persist();
});
