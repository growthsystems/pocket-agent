/**
 * PA Notify Server — HTTP endpoint for Jarvis push notifications
 *
 * Listens on port 4002 for POST /notify requests from Jarvis daemon.
 * Forwards notifications to desktop (native Notification) and Telegram.
 *
 * Payload shape:
 *   { type: string; title: string; body: string; urgency: 'low' | 'normal' | 'high' }
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

const NOTIFY_PORT = 4002;
const MAX_BODY_SIZE = 64 * 1024; // 64KB safety limit

interface Notification {
  type: string;
  title: string;
  body: string;
  urgency: string;
}

type NotifyHandler = (notification: Notification) => void;

/** Callback that provides access to MemoryManager queries without tight coupling. */
export interface MemoryQueryResult {
  facts: string;
  dailyLogs: string;
}

export interface HistoryQueryResult {
  messages: unknown[];
  session_id: string;
}

type MemoryQueryHandler = () => { context: MemoryQueryResult; history: (limit: number) => HistoryQueryResult };

let handler: NotifyHandler | null = null;
let memoryHandler: MemoryQueryHandler | null = null;
let server: Server | null = null;

export function setNotifyHandler(h: NotifyHandler): void {
  handler = h;
}

export function setMemoryQueryHandler(h: MemoryQueryHandler): void {
  memoryHandler = h;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer | string) => {
      size += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function validateNotification(parsed: unknown): Notification | null {
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  const type = typeof obj.type === 'string' ? obj.type : 'info';
  const urgency = typeof obj.urgency === 'string' ? obj.urgency : 'normal';

  if (!title) return null;

  return { type, title, body, urgency };
}

/** Exported for testing — creates the HTTP request handler without binding to a port. */
export function createRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'pocket-agent-notify' });
      return;
    }

    // Notify endpoint
    if (req.method === 'POST' && req.url === '/notify') {
      try {
        const rawBody = await readBody(req);
        const parsed: unknown = JSON.parse(rawBody);
        const notification = validateNotification(parsed);

        if (!notification) {
          sendJson(res, 400, { error: 'Invalid notification: title is required' });
          return;
        }

        console.log(`[Notify] Received: [${notification.type}] ${notification.title}`);

        if (handler) {
          handler(notification);
        } else {
          console.warn('[Notify] No handler registered, notification dropped');
        }

        sendJson(res, 202, { received: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message === 'Request body too large') {
          sendJson(res, 413, { error: 'Request body too large' });
        } else {
          sendJson(res, 400, { error: 'Invalid JSON' });
        }
      }
      return;
    }

    // Context API — returns facts + daily logs for Jarvis enrichment
    if (req.method === 'GET' && req.url === '/api/context') {
      if (!memoryHandler) {
        sendJson(res, 503, { error: 'Memory handler not yet registered' });
        return;
      }
      try {
        const { context } = memoryHandler();
        sendJson(res, 200, { facts: context.facts, dailyLogs: context.dailyLogs });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Notify] /api/context error:', message);
        sendJson(res, 500, { error: 'Failed to load context' });
      }
      return;
    }

    // History API — returns recent messages from the latest session
    if (req.method === 'GET' && (req.url?.startsWith('/api/history') ?? false)) {
      if (!memoryHandler) {
        sendJson(res, 503, { error: 'Memory handler not yet registered' });
        return;
      }
      try {
        const urlObj = new URL(req.url!, `http://${req.headers.host ?? 'localhost'}`);
        const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get('limit') ?? '20', 10) || 20, 1), 100);
        const { history } = memoryHandler();
        const result = history(limit);
        sendJson(res, 200, { messages: result.messages, session_id: result.session_id });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Notify] /api/history error:', message);
        sendJson(res, 500, { error: 'Failed to load history' });
      }
      return;
    }

    // Not found
    res.writeHead(404);
    res.end();
  };
}

export function startNotifyServer(): void {
  if (server) {
    console.warn('[Notify] Server already running');
    return;
  }

  server = createServer(createRequestHandler());

  server.listen(NOTIFY_PORT, '127.0.0.1', () => {
    console.log(`[Notify] PA notify server listening on 127.0.0.1:${NOTIFY_PORT}`);
  });

  server.on('error', (err: Error) => {
    console.warn(`[Notify] Failed to start notify server: ${err.message}`);
    server = null;
    // Don't crash PA if port is in use
  });
}

export function stopNotifyServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log('[Notify] Server stopped');
  }
}
