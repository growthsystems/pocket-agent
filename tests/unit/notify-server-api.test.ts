import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import {
  createRequestHandler,
  setMemoryQueryHandler,
} from '../../src/notify-server';

/**
 * Tests for the PA notify server's context API endpoints.
 * Uses createRequestHandler() on a dynamic port to avoid conflicts
 * with the real PA server running on 4002.
 */

let testServer: http.Server;
let testPort: number;

function httpGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${testPort}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('Timeout'));
    });
  });
}

describe('Notify Server — Context API', () => {
  beforeAll(async () => {
    testServer = http.createServer(createRequestHandler());
    await new Promise<void>((resolve) => {
      // Port 0 = OS picks a free port
      testServer.listen(0, '127.0.0.1', () => {
        const addr = testServer.address();
        testPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      testServer.close(() => resolve());
    });
  });

  describe('GET /api/context', () => {
    it('returns 503 when memory handler is not registered', async () => {
      // Reset handler to null state
      setMemoryQueryHandler(null as never);
      const { status, body } = await httpGet('/api/context');

      expect(status).toBe(503);
      expect(body.error).toBe('Memory handler not yet registered');
    });

    it('returns facts and daily logs when handler is registered', async () => {
      setMemoryQueryHandler(() => ({
        context: {
          facts: '## Known Facts\n- **Name**: Vasanth',
          dailyLogs: '## Recent Daily Logs\n### Today\nWorked on Jarvis integration',
        },
        history: (limit: number) => ({
          messages: [{ role: 'user', content: 'hello' }].slice(0, limit),
          session_id: 'sess-abc',
        }),
      }));

      const { status, body } = await httpGet('/api/context');

      expect(status).toBe(200);
      expect(body.facts).toContain('Known Facts');
      expect(body.dailyLogs).toContain('Daily Logs');
    });
  });

  describe('GET /api/history', () => {
    it('returns recent messages with default limit', async () => {
      setMemoryQueryHandler(() => ({
        context: { facts: '', dailyLogs: '' },
        history: (limit: number) => ({
          messages: Array.from({ length: limit }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `message ${i}`,
          })),
          session_id: 'sess-test',
        }),
      }));

      const { status, body } = await httpGet('/api/history');

      expect(status).toBe(200);
      expect(Array.isArray(body.messages)).toBe(true);
      expect((body.messages as unknown[]).length).toBe(20); // default limit
      expect(body.session_id).toBe('sess-test');
    });

    it('respects custom limit parameter', async () => {
      const { status, body } = await httpGet('/api/history?limit=5');

      expect(status).toBe(200);
      expect((body.messages as unknown[]).length).toBe(5);
    });

    it('caps limit at 100', async () => {
      const { status, body } = await httpGet('/api/history?limit=999');

      expect(status).toBe(200);
      expect((body.messages as unknown[]).length).toBe(100);
    });
  });

  describe('GET /health', () => {
    it('still works alongside new endpoints', async () => {
      const { status, body } = await httpGet('/health');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.service).toBe('pocket-agent-notify');
    });
  });

  describe('error handling', () => {
    it('returns 500 when handler throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setMemoryQueryHandler(() => {
        throw new Error('Database locked');
      });

      const { status, body } = await httpGet('/api/context');

      expect(status).toBe(500);
      expect(body.error).toBe('Failed to load context');

      consoleSpy.mockRestore();
    });
  });
});
