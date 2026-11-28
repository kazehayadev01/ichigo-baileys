# Changelog

## [1.0.6] - 2026-11-28
- WAProto diperbarui ke WhatsApp Web `2.3000.1056409569` (sumber: wppconnect-team/wa-proto, di-merge: 46 entitas baru, field baru `themeMessage` dan `VpcRequestMessage.token`, struktur Labyrinth `*Output` baru). Entitas dan field yang sudah ada di proto sebelumnya tetap dipertahankan; `required` diubah menjadi `optional`.
- Versi WhatsApp Web default (fallback) disamakan ke build `1056409569`. Versi lama yang sudah usang menyebabkan pairing code gagal ("Couldn't link device").

## [1.0.5] - 2026-11-28
- Fix `sendStickerAudio()`: patch `proto.Message.encode` kini dipasang sekali (idempoten) dan tidak dikembalikan setelah kirim. Sebelumnya, dua pengiriman yang tumpang tindih bisa membuat `encode` global menempel ke versi patch dan memengaruhi pesan lain sampai bot di-restart.
- Fix `sendStickerAudio()`: transparansi gambar sticker dipertahankan (sebelumnya area transparan menjadi hitam karena `pad` tanpa alpha).
- `sendStickerAudio()`: audio kini punya `seconds`, `ptt` dan `waveform`, jadi durasi dan bentuk gelombang tampil benar di WhatsApp. Opsi baru `ptt` (default `true`) dan `maxSeconds` (default `300`); audio yang lebih panjang dipotong, dan Ogg yang melebihi batas di-encode ulang. Hasil kembalian menyertakan `audio.seconds`.
- TypeScript declarations `sendStickerAudio` diperbarui (`ptt?`, `maxSeconds?`).

## [1.0.4] - 2026-11-28
- VoIP: new `VoipClient` option `autoRejectIncoming` — incoming call offers are rejected automatically (the active outgoing call is never affected).
- Call events: added `preaccept` status (previously reported as `ringing`), plus `reason`, `durationSec` and `latencyMs` fields; `groupJid` is kept on follow-up events of group calls.
- `rejectCall()` now throws a clear error when `callId` or `callFrom` is missing instead of sending a malformed stanza.
- TypeScript declarations (`WACallEvent`, `WACallUpdateType`) updated.
- README: documented auto-reject and the `call` event fields.
- VoIP hardening (diporting dari `baileys-main`, versi tetap 1.0.4):
  - Fix: `#activeCall` tidak pernah dikosongkan setelah panggilan selesai, sehingga panggilan berikutnya selalu gagal "A call is already active" dan buffer capture/ffmpeg menggantung. Sekarang dibersihkan saat `ended`.
  - Fix: callback global WASM hanya didaftarkan untuk engine pertama; setelah `disconnect()`/reconnect, sinyal masih diarahkan ke client lama. Sekarang didaftarkan per engine dan dilepas saat `destroy()`.
  - Fix: `SignalingBridge.init()` membungkus `authState.keys.set` di setiap panggilan (tumpukan wrapper tiap reconnect, session makin berat). Sekarang dibungkus sekali dan dikembalikan lewat `destroy()`.
  - Session lebih ringan: sesi Signal tidak di-fetch dua kali per panggilan; map token/sesi in-memory dibatasi ukurannya; listener `CB:call`/`CB:receipt`/`call`/`connection.update` dilepas saat disconnect; worker WASM di-`unref`.
  - Baru: target panggilan bisa nomor, JID, atau LID (`@lid`); opsi `audio` (path/URL/Buffer/`lavfi:`) dan `loop`; `endCall()`, `mute()`, `getActiveCall()`, `isInitialized()`, `connect()`; `ActiveCall.end(reason)`.
  - Baru: `lib/VoIP/index.d.ts` (tipe `VoipClient`, `ActiveCall`, `VoipClientConfig`).
- Auth state: `getAuthStateStats(folder)` dan `pruneAuthState(folder, opts)` untuk memantau dan membersihkan folder session multi-file (default hanya file yang aman dibuang; sesi/sender-key opt-in).
- Varian session lain juga dibuat lebih ringan dan aman:
  - `useSingleFileAuthState`: penulisan atomik (anti file terpotong saat crash) dan banyak `keys.set` beruntun digabung jadi satu tulis (sebelumnya tiap set menulis ulang seluruh file).
  - `useSingleFileSQLJsAuthState`: `db.export()` + tulis file sekali per `keys.set` (sebelumnya sekali per key), digabung dan atomik.
  - `useMultiFileSQLJsAuthState`: penulisan atomik, dan lock per file dilepas bila tidak dipakai (Map tidak tumbuh terus).
  - `getAuthStateStats`/`pruneAuthState` kini juga mengenali file `.db` (varian SQLite/sql.js).

## [1.0.3]
- Fix `sendStatusMentions()`: statuses were not delivered to group participants using LID; the recipient list now uses real phone numbers.

## [1.0.2] - 2026-11-27
- Added `sendStatusMentions()` as an alias of `sendStatusMention()` (same behavior, same arguments).
- Added `sendStickerAudio(jid, { audio, sticker }, options)`: experimental audio sticker (WebP sticker + audio sent through protobuf field 134). `audio` and `sticker` accept a Buffer, a local path or an http(s) URL; `sticker` defaults to `./media/menu.jpg`. Requires `ffmpeg`.
- SQLite auth state (`better-sqlite3`): shared pragmas (`busy_timeout`, `mmap_size = 0`, `temp_store = FILE`, `soft_heap_limit`); the single-file variant now uses WAL, writes each `keys.set` batch in one transaction and exposes `close()`.
- Multi-file SQLite auth state: per-file locks are now released when unused (previously the lock map grew with every key), and per-connection page cache is reduced.
- TypeScript declarations updated for the new methods.

## [1.0.1] - 2026-11-25
- Package renamed to `@kaze012/ichigo-baileys`; repository moved to `kazehayadev01/ichigo-baileys`.
- WAProto updated to WhatsApp Web `2.3000.1056191857`. Types and fields present in the previous proto but absent upstream are kept. Default WhatsApp Web version updated to the same build.

## [1.0.0]
- Initial release.
