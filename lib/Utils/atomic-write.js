import { rename, unlink, writeFile } from 'fs/promises';
// Helper internal (tidak diekspor dari Utils/index.js).
/**
 * Tulis ke file sementara lalu rename (atomik di filesystem yang sama): kalau proses
 * mati di tengah write, file tujuan tetap versi lama yang utuh — tidak pernah terpotong.
 */
export const writeFileAtomic = async (filePath, data) => {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeFile(tmpPath, data);
        await rename(tmpPath, filePath);
    }
    catch (error) {
        await unlink(tmpPath).catch(() => { });
        throw error;
    }
};
/**
 * Gabungkan banyak permintaan simpan beruntun jadi satu penulisan: kalau ada write yang
 * sedang jalan, permintaan baru cuma menandai "kotor" dan write diulang sekali setelahnya.
 * Promise yang dikembalikan selesai setelah state TERBARU tersimpan.
 */
export const makeCoalescedWriter = (write) => {
    let running = null;
    let dirty = false;
    return () => {
        dirty = true;
        if (!running) {
            running = (async () => {
                try {
                    while (dirty) {
                        dirty = false;
                        await write();
                    }
                }
                finally {
                    running = null;
                }
            })();
        }
        return running;
    };
};
