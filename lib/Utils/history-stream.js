/**
 * Streaming history sync with a user `sink` (ported from zapo-js, MIT).
 * Decodes a HistorySync chunk as it downloads: each message of each conversation is
 * delivered to `sink.item()` immediately, so memory tracks the largest record instead of
 * the whole chunk. A slow sink pauses the download. Items arrive before the media MAC is
 * verified; on failure `sink.abort()` runs and the primary may resend (dedupe by key.id).
 */
import { createInflate } from 'zlib';
import { proto } from '../../WAProto/index.js';
import { downloadContentFromMessage } from './messages-media.js';
import { PROTO_STREAM_EVENT_KINDS, streamProtoFields } from './proto-stream/proto-stream.js';
const HISTORY_FIELDS = { SYNC_TYPE: 1, CONVERSATIONS: 2 };
const CONVERSATION_MESSAGES = 2;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
// HistorySync field number -> sink kind, with the proto type used to decode it (null = raw bytes / varint)
const FIELD_KINDS = new Map([
    [3, ['statusV3Messages', proto.HistorySyncMsg]],
    [5, ['chunkOrder', null]],
    [6, ['progress', null]],
    [7, ['pushnames', proto.Pushname]],
    [8, ['globalSettings', null]],
    [9, ['threadIdUserSecret', null]],
    [10, ['threadDsTimeframeOffset', null]],
    [11, ['recentStickers', null]],
    [12, ['pastParticipants', null]],
    [13, ['callLogRecords', null]],
    [14, ['aiWaitListState', null]],
    [15, ['phoneNumberToLidMappings', proto.PhoneNumberToLIDMapping]],
    [16, ['companionMetaNonce', null]],
    [17, ['shareableChatIdentifierEncryptionKey', null]],
    [18, ['accounts', null]],
    [19, ['nctSalt', null]],
    [20, ['inlineContacts', proto.InlineContact]],
    [21, ['inlineContactsProvided', null]]
]);
const concat = (parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
const SYNC_TYPES = proto.HistorySync.HistorySyncType;
/**
 * @param msg IHistorySyncNotification
 * @param options request options (same as downloadHistory)
 * @param sink { item(item, chunk), commit?(summary), abort?(chunk, error) }
 * @param logger optional
 * @returns summary { syncType, chunkOrder, progress, conversations, messages, pushnames, inlineContacts }
 */
export const streamHistorySync = async (msg, options, sink, logger) => {
    const chunk = { id: msg.peerDataRequestSessionId || msg.directPath || msg.fileSha256?.toString?.('hex'), syncType: msg.syncType };
    const summary = { ...chunk, conversations: 0, messages: 0, pushnames: 0, inlineContacts: 0, chunkOrder: undefined, progress: undefined };
    try {
        let source;
        if (msg.initialHistBootstrapInlinePayload) {
            const { Readable } = await import('stream');
            source = Readable.from([Buffer.from(msg.initialHistBootstrapInlinePayload)]).pipe(createInflate());
        }
        else {
            const raw = await downloadContentFromMessage(msg, 'md-msg-hist', { options });
            source = raw.pipe ? raw.pipe(createInflate()) : raw;
            raw.on?.('error', err => source.destroy(err));
        }
        let header = null;
        let jid = null;
        const deliver = (kind, value) => sink.item({ kind, value }, chunk);
        const onEvent = (event) => {
            if (event.kind === PROTO_STREAM_EVENT_KINDS.ENTER) {
                header = [];
                jid = null;
                summary.conversations += 1;
                return undefined;
            }
            if (event.kind === PROTO_STREAM_EVENT_KINDS.LEAVE) {
                const parts = header;
                header = null;
                if (!parts)
                    return undefined;
                const conversation = proto.Conversation.decode(concat(parts));
                return deliver('conversations', conversation);
            }
            if (event.depth === 1) {
                // inside a conversation
                if (event.fieldNumber === CONVERSATION_MESSAGES && event.wireType === 2) {
                    summary.messages += 1;
                    return deliver('conversations.messages', { conversationId: jid, message: proto.HistorySyncMsg.decode(event.value.slice()) });
                }
                if (event.fieldNumber === 1 && event.wireType === 2)
                    jid = Buffer.from(event.value).toString('utf8');
                if (header)
                    header.push(event.raw.slice());
                return undefined;
            }
            if (event.fieldNumber === HISTORY_FIELDS.SYNC_TYPE || event.fieldNumber === HISTORY_FIELDS.CONVERSATIONS)
                return undefined;
            const entry = FIELD_KINDS.get(event.fieldNumber);
            if (!entry)
                return undefined;
            const [kind, type] = entry;
            if (kind === 'chunkOrder')
                summary.chunkOrder = event.varintValue;
            if (kind === 'progress')
                summary.progress = event.varintValue;
            if (kind === 'pushnames')
                summary.pushnames += 1;
            if (kind === 'inlineContacts')
                summary.inlineContacts += 1;
            if (event.wireType === 0)
                return deliver(kind, event.varintValue);
            const bytes = event.value.slice();
            return deliver(kind, type ? type.decode(bytes) : bytes);
        };
        await streamProtoFields(source, onEvent, {
            shouldDescend: (field, depth) => depth === 0 && field === HISTORY_FIELDS.CONVERSATIONS,
            maxFieldBytes: MAX_RECORD_BYTES
        });
        await sink.commit?.(summary);
        logger?.debug({ ...summary }, 'history sync streamed to sink');
        return summary;
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        try {
            await sink.abort?.(chunk, err);
        }
        catch (abortErr) {
            logger?.warn({ err: abortErr }, 'history sink abort failed');
        }
        throw err;
    }
};
export { SYNC_TYPES as HistorySyncType };
