# Changelog

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
