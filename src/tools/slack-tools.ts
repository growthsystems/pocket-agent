/**
 * Slack tools for the agent
 *
 * - slack_post: Post a message to a Slack channel
 * - slack_read_thread: Read replies in a Slack thread
 * - slack_channels: List available program channels
 */

import {
  PASlackClient,
  PROGRAM_CHANNELS,
  PROJECT_TO_PROGRAM,
  resolveChannel,
  FALLBACK_CHANNEL,
} from '../channels/slack';

let slackClient: PASlackClient | null = null;

/**
 * Initialize the Slack client with a token.
 * Called externally when the token becomes available.
 */
export function setSlackClient(client: PASlackClient): void {
  slackClient = client;
}

/**
 * Lazily resolve a Slack client.
 * Tries the explicitly set client first, then falls back to SLACK_BOT_TOKEN env var.
 */
function getSlackClient(): PASlackClient | null {
  if (slackClient) return slackClient;

  const token = process.env.SLACK_BOT_TOKEN;
  if (token) {
    slackClient = new PASlackClient(token);
    return slackClient;
  }

  return null;
}

// ---------------------------------------------------------------------------
// slack_post
// ---------------------------------------------------------------------------

/**
 * Slack post tool definition
 */
export function getSlackPostToolDefinition() {
  return {
    name: 'slack_post',
    description: 'Post a message to a Slack channel. Specify a project name to auto-resolve the channel, or provide a channel ID directly. Defaults to #jarvis-general.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID (e.g., "C0AHR0LD9E2"). Optional if project is provided.',
        },
        project: {
          type: 'string',
          description: 'Project name to resolve channel (e.g., "jarvis", "floe"). Optional if channel is provided.',
        },
        text: {
          type: 'string',
          description: 'The message text to post',
        },
        thread_ts: {
          type: 'string',
          description: 'Optional thread timestamp to reply in a thread',
        },
      },
      required: ['text'],
    },
  };
}

/**
 * Slack post tool handler
 */
export async function handleSlackPostTool(input: unknown): Promise<string> {
  const { channel, project, text, thread_ts } = input as {
    channel?: string;
    project?: string;
    text: string;
    thread_ts?: string;
  };

  if (!text || text.trim().length === 0) {
    return JSON.stringify({ error: 'text is required' });
  }

  const client = getSlackClient();
  if (!client) {
    return JSON.stringify({
      success: false,
      message: 'Slack is not configured. Set SLACK_BOT_TOKEN environment variable or configure Slack in settings.',
    });
  }

  // Resolve the target channel
  const targetChannel = channel || resolveChannel(project);

  try {
    const result = await client.postMessage(targetChannel, text, thread_ts);

    if (result.ok) {
      console.log(`[SlackTools] Message posted to ${targetChannel}`);
      return JSON.stringify({
        success: true,
        message: `Message posted to channel ${targetChannel}`,
        ts: result.ts,
      });
    }

    return JSON.stringify({
      success: false,
      message: `Slack API error: ${result.error ?? 'unknown'}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[SlackTools] Post failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: `Failed to post message: ${msg}`,
    });
  }
}

// ---------------------------------------------------------------------------
// slack_read_thread
// ---------------------------------------------------------------------------

/**
 * Slack read thread tool definition
 */
export function getSlackReadThreadToolDefinition() {
  return {
    name: 'slack_read_thread',
    description: 'Read all replies in a Slack thread. Returns messages with user, text, and timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel ID containing the thread',
        },
        thread_ts: {
          type: 'string',
          description: 'Thread timestamp (the ts of the parent message)',
        },
      },
      required: ['channel', 'thread_ts'],
    },
  };
}

/**
 * Slack read thread tool handler
 */
export async function handleSlackReadThreadTool(input: unknown): Promise<string> {
  const { channel, thread_ts } = input as {
    channel: string;
    thread_ts: string;
  };

  if (!channel || !thread_ts) {
    return JSON.stringify({ error: 'Both channel and thread_ts are required' });
  }

  const client = getSlackClient();
  if (!client) {
    return JSON.stringify({
      success: false,
      message: 'Slack is not configured. Set SLACK_BOT_TOKEN environment variable or configure Slack in settings.',
    });
  }

  try {
    const messages = await client.getThreadReplies(channel, thread_ts);

    if (messages.length === 0) {
      return JSON.stringify({
        success: true,
        message: 'No replies found in this thread.',
        replies: [],
      });
    }

    const formatted = messages.map((msg) => ({
      user: msg.user ?? msg.bot_id ?? 'unknown',
      text: msg.text,
      ts: msg.ts,
    }));

    return JSON.stringify({
      success: true,
      count: formatted.length,
      replies: formatted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[SlackTools] Thread read failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: `Failed to read thread: ${msg}`,
    });
  }
}

// ---------------------------------------------------------------------------
// slack_channels
// ---------------------------------------------------------------------------

/**
 * Slack channels tool definition
 */
export function getSlackChannelsToolDefinition() {
  return {
    name: 'slack_channels',
    description: 'List all known program channels and their Slack channel IDs. Shows which projects route to which channels.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * Slack channels tool handler
 */
export async function handleSlackChannelsTool(_input: unknown): Promise<string> {
  // Build a program-to-projects reverse map
  const programProjects: Record<string, string[]> = {};
  for (const [project, program] of Object.entries(PROJECT_TO_PROGRAM)) {
    if (!programProjects[program]) {
      programProjects[program] = [];
    }
    programProjects[program].push(project);
  }

  const channels = Object.entries(PROGRAM_CHANNELS).map(([program, channelId]) => ({
    program,
    channel_id: channelId,
    projects: programProjects[program] ?? [],
    is_fallback: channelId === FALLBACK_CHANNEL,
  }));

  return JSON.stringify({
    success: true,
    count: channels.length,
    channels,
  });
}

// ---------------------------------------------------------------------------
// Export all Slack tools
// ---------------------------------------------------------------------------

/**
 * Get all Slack tools
 */
export function getSlackTools() {
  return [
    {
      ...getSlackPostToolDefinition(),
      handler: handleSlackPostTool,
    },
    {
      ...getSlackReadThreadToolDefinition(),
      handler: handleSlackReadThreadTool,
    },
    {
      ...getSlackChannelsToolDefinition(),
      handler: handleSlackChannelsTool,
    },
  ];
}
