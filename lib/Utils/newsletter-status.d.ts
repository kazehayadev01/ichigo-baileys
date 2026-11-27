import { proto } from "../../WAProto/index.js";
/** Opsi sendNewsletterStatus. Sisa properti diteruskan ke generateWAMessage. */
export interface NewsletterStatusOptions {
  /** pakai handle media yang sudah diunggah (lewati upload) */
  mediaId?: string;
  mediaHandle?: string;
  parentServerId?: number | string;
  responseServerId?: number | string;
  interactionType?: "question" | "question_response" | "question_reshare";
  aiContent?: boolean;
  /** tambah contextInfo.statusAttributions NEWSLETTER_STATUS (default true) */
  statusAttribution?: boolean;
  messageId?: string;
  /** default 20000 */
  ackTimeoutMs?: number;
  /** false: jangan tunggu server_id dari <status> (default menunggu) */
  resolveServerId?: boolean;
  /** default 8000 */
  serverIdTimeoutMs?: number;
  [key: string]: any;
}
export interface NewsletterStatusAck {
  class?: string;
  from?: string;
  id?: string;
  t?: number;
  serverId?: number;
  edit?: string;
  error?: string;
  applicationError?: number;
  backoff?: number;
  node: any;
}
export interface NewsletterStatusItem {
  id?: string;
  serverId?: number;
  t?: number;
  isSender: boolean;
  type?: string;
  edit?: string;
  mediaType?: string;
  interactionType?: string;
  reaction?: string;
  adminProfile?: { id?: string; name?: string; pictureId?: string; pictureDirectPath?: string };
  paidPartnership: boolean;
  aiContent: boolean;
  editTimestamp?: number;
  originalTimestamp?: number;
  reactionCounts?: { code?: string; count?: number }[];
  viewsCount?: number;
  responsesCount?: number;
  message?: proto.Message;
  node: any;
}
export interface NewsletterStatusList {
  jid?: string;
  t?: number;
  statuses: NewsletterStatusItem[];
}
export interface NewsletterStatusSendResult {
  key: proto.IMessageKey;
  status: number;
  newsletterStatusServerId?: number;
  newsletterStatusAck: NewsletterStatusAck;
  newsletterStatusResponse: any;
  [key: string]: any;
}
export declare const NEWSLETTER_STATUS_MEDIA_TYPES: Set<string>;
export declare const NEWSLETTER_STATUS_WEB_MEDIA_TYPES: Set<string>;
export declare const NEWSLETTER_STATUS_CONTENT_TYPES: Set<string>;
export declare const NEWSLETTER_SERVER_ID_MIN: number;
export declare const NEWSLETTER_SERVER_ID_MAX: number;
export declare const getNewsletterStatusMediaType: (message: proto.IMessage) => "image" | "video" | "gif" | "audio" | undefined;
export declare const toNewsletterServerId: (value: number | string, label?: string) => string;
export declare const withNewsletterStatusAttribution: <T extends object>(content: T) => T;
export declare const parseNewsletterStatusAck: (node: any, opts?: { jid?: string; messageId?: string }) => NewsletterStatusAck;
export declare const waitForNewsletterStatusServerId: (sock: any, opts: { jid?: string; messageId?: string; timeoutMs?: number }) => Promise<{ serverId: number; node: any } | undefined> & { cancel(): void };
export declare const buildNewsletterAdminProfileStatusMessage: (message: proto.IMessage) => proto.Message;
export declare const buildNewsletterStatusNode: (opts: any) => any;
export declare const buildNewsletterStatusReactionNode: (opts: any) => any;
export declare const buildNewsletterStatusRevokeNode: (opts: any) => any;
export declare const makeNewsletterStatusSender: (sock: any, config: any) => (jid: string, content: any, options?: NewsletterStatusOptions) => Promise<NewsletterStatusSendResult>;
export declare const makeNewsletterStatusReactionSender: (sock: any) => (jid: string, parentServerId: number | string, reaction?: string, options?: { messageId?: string; ackTimeoutMs?: number }) => Promise<NewsletterStatusSendResult>;
export declare const makeNewsletterStatusRevokeSender: (sock: any) => (jid: string, statusId: string, options?: { ackTimeoutMs?: number }) => Promise<NewsletterStatusSendResult>;
export declare const parseNewsletterStatusUpdatesResponse: (node: any) => NewsletterStatusList;
export declare const makeNewsletterStatusUpdatesFetcher: (sock: any) => (jid: string, options?: { count?: number; since?: number | string; before?: number | string; after?: number | string }) => Promise<NewsletterStatusList>;
export declare const parseNewsletterStatusesResponse: (node: any) => NewsletterStatusList;
export declare const makeNewsletterStatusFetcher: (sock: any) => (jid: string, options?: { count?: number; before?: number | string; after?: number | string; viewRole?: string }) => Promise<NewsletterStatusList>;
