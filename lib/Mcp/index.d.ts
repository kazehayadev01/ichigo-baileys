export interface McpServerOptions {
    /** Izinkan tool pengirim pesan. Default false (hanya baca). */
    allowSend?: boolean;
    /** Jika diisi, kirim pesan hanya ke jid/nomor ini. */
    allowedJids?: string[];
    /** Default 10. */
    maxSendsPerMinute?: number;
    /** Simpan N pesan masuk terakhir di memori (maks 1000). Default 0 (mati). */
    bufferMessages?: number;
    /** Batasi tool yang aktif berdasarkan nama. */
    tools?: string[];
    serverInfo?: { name?: string; version?: string };
}
export interface McpHttpOptions {
    port?: number;
    host?: string;
    /** Wajib, minimal 16 karakter. */
    token: string;
    path?: string;
    allowedOrigins?: string[];
}
export interface McpServer {
    handle(message: unknown): Promise<unknown | null>;
    handleRaw(text: string): Promise<unknown | null>;
    serveStdio(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<{ close(): void }>;
    serveHttp(opts: McpHttpOptions): Promise<{ server: import('node:http').Server; port: number; close(): Promise<void> }>;
    listTools(): Array<{ name: string; title: string; description: string; inputSchema: object; annotations: object }>;
    close(): void;
}
export declare const makeMcpServer: (sock: any, options?: McpServerOptions) => McpServer;
export default makeMcpServer;
