/**
 * PASlackClient — lightweight Slack Web API client for Pocket Agent.
 *
 * Supports posting messages, reading threads, and fetching reactions.
 * Handles rate limiting with exponential backoff (same pattern as Jarvis's brain/slack.ts).
 * @module channels/slack
 */

// --------------- Types ---------------

export interface SlackResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reactions?: SlackReaction[];
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

// --------------- Constants ---------------

const SLACK_API = 'https://slack.com/api';
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

// --------------- Channel Routing (replicated from jarvis/brain/channel-map.ts) ---------------

/**
 * Program channel IDs (Slack).
 * Source of truth: jarvis/brain/channel-map.ts
 */
export const PROGRAM_CHANNELS: Record<string, string> = {
  'command-center': 'C0AHR1RGMDL',
  'video-hub': 'C0AJ60DR7HP',
  'content-flywheel': 'C0AJMBCJ2KS',
  'communities': 'C0AHPL72NKF',
  'media-house': 'C0AJMB4N3CG',
  'passive-income': 'C0AJMBHTHS4',
  'alerts': 'C0AHR0R1WFQ',
  'general': 'C0AHR0LD9E2',
};

export const FALLBACK_CHANNEL = PROGRAM_CHANNELS['general'];

/**
 * Maps project keys to program keys.
 * Source of truth: jarvis/brain/channel-map.ts
 */
export const PROJECT_TO_PROGRAM: Record<string, string> = {
  // Command Center
  'jarvis': 'command-center',
  'mission-control': 'command-center',
  'pocket-agent': 'command-center',
  // Video Hub
  'floe': 'video-hub',
  'kino-kraft-web': 'video-hub',
  // Content Flywheel
  'cfw-social': 'content-flywheel',
  'cfw-website': 'content-flywheel',
  'action-builder': 'content-flywheel',
  // Communities
  'learnloop': 'communities',
  'communities': 'communities',
  // Media House
  'creative-studio': 'media-house',
  'outbound': 'media-house',
  // Passive Income
  'heritage-house': 'passive-income',
  'mr-growth-guide': 'passive-income',
};

/**
 * Maps event source strings to program keys.
 */
const SOURCE_TO_PROGRAM: Record<string, string> = {
  'youtube': 'video-hub',
  'github': 'command-center',
  'cron': 'command-center',
  'slack': 'general',
  'telegram': 'alerts',
  'webhook': 'alerts',
  'mission-control': 'general',
};

/**
 * Resolve the Slack channel ID for a given project key.
 */
export function resolveChannelForProject(project: string): string | undefined {
  const program = PROJECT_TO_PROGRAM[project];
  if (program) {
    return PROGRAM_CHANNELS[program];
  }
  return undefined;
}

/**
 * Resolve the Slack channel ID for a given event source.
 */
export function resolveChannelForSource(source: string): string | undefined {
  const program = SOURCE_TO_PROGRAM[source];
  if (program) {
    return PROGRAM_CHANNELS[program];
  }
  return undefined;
}

/**
 * Resolve the best Slack channel -- checks project first, then event source,
 * falls back to #jarvis-general.
 */
export function resolveChannel(project?: string, source?: string): string {
  if (project) {
    const ch = resolveChannelForProject(project);
    if (ch) return ch;
  }
  if (source) {
    const ch = resolveChannelForSource(source);
    if (ch) return ch;
  }
  return FALLBACK_CHANNEL;
}

// --------------- Client ---------------

/**
 * Lightweight Slack Web API client for Pocket Agent.
 * Uses native fetch, handles rate limits with exponential backoff.
 */
export class PASlackClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Post a message to a Slack channel or thread.
   */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<SlackResponse> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const data = await this.callSlack<{ ok: boolean; ts?: string; error?: string }>(
      'chat.postMessage',
      body,
    );
    return { ok: data.ok, ts: data.ts, error: data.error };
  }

  /**
   * Retrieve all replies in a message thread.
   */
  async getThreadReplies(
    channel: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    const data = await this.callSlackGet<{ ok: boolean; messages?: SlackMessage[] }>(
      'conversations.replies',
      { channel, ts: threadTs },
    );
    return data.messages ?? [];
  }

  /**
   * Get reactions on a specific message.
   */
  async getReactions(
    channel: string,
    timestamp: string,
  ): Promise<SlackReaction[]> {
    const data = await this.callSlack<{
      ok: boolean;
      message?: { reactions?: SlackReaction[] };
    }>('reactions.get', { channel, timestamp, full: true });
    return data.message?.reactions ?? [];
  }

  // ---- Private helpers ----

  /**
   * POST-based Slack API caller with rate-limit retry logic.
   */
  private async callSlack<T extends { ok: boolean; error?: string }>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${SLACK_API}/${method}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        if (attempt === MAX_RETRIES) {
          console.error(`[PASlack] Rate limited on ${method} after ${MAX_RETRIES} retries`);
          throw new Error(`Rate limited on ${method} after ${MAX_RETRIES} retries`);
        }
        const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_DELAY_MS / 1_000;
        await this.sleep(retryAfter * 1_000);
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as T;
        console.error(`[PASlack] HTTP ${res.status} on ${method}:`, errorBody);
        throw new Error(`Slack API HTTP error ${res.status} on ${method}: ${(errorBody as { error?: string }).error ?? 'unknown'}`);
      }

      const data = (await res.json()) as T;
      if (!data.ok) {
        console.error(`[PASlack] API error on ${method}:`, data.error);
      }
      return data;
    }

    throw new Error(`Unexpected exit from retry loop on ${method}`);
  }

  /**
   * GET-based Slack API caller for methods that require query params
   * (e.g., conversations.replies).
   */
  private async callSlackGet<T extends { ok: boolean; error?: string }>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${SLACK_API}/${method}?${query.toString()}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });

      if (res.status === 429) {
        if (attempt === MAX_RETRIES) {
          console.error(`[PASlack] Rate limited on ${method} after ${MAX_RETRIES} retries`);
          throw new Error(`Rate limited on ${method} after ${MAX_RETRIES} retries`);
        }
        const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_DELAY_MS / 1_000;
        await this.sleep(retryAfter * 1_000);
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as T;
        console.error(`[PASlack] HTTP ${res.status} on ${method}:`, errorBody);
        throw new Error(`Slack API HTTP error ${res.status} on ${method}: ${(errorBody as { error?: string }).error ?? 'unknown'}`);
      }

      const data = (await res.json()) as T;
      if (!data.ok) {
        console.error(`[PASlack] API error on ${method}:`, data.error);
      }
      return data;
    }

    throw new Error(`Unexpected exit from retry loop on ${method}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
