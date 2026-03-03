/**
 * Jarvis integration tools for the agent
 *
 * - jarvis_run_chain: Trigger a Jarvis chain manually
 * - jarvis_status: Check Jarvis daemon health
 * - jarvis_journal: Fetch today's journal entries
 * - jarvis_list_chains: List available chains
 * - jarvis_dispatch_task: Dispatch a task to Jarvis
 */

const JARVIS_EVENT_URL = 'http://localhost:4001/event';
const JARVIS_BASE_URL = 'http://localhost:4001';
const REQUEST_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// jarvis_run_chain
// ---------------------------------------------------------------------------

/**
 * Run chain tool definition
 */
export function getRunChainToolDefinition() {
  return {
    name: 'jarvis_run_chain',
    description: 'Trigger a Jarvis chain manually. Use this to kick off workflows like morning-briefing, nightly-digest, video-distribution, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chain_id: {
          type: 'string',
          description: 'The chain ID to trigger (e.g., "morning-briefing", "video-distribution")',
        },
        payload: {
          type: 'object',
          description: 'Optional additional payload data to pass to the chain',
        },
      },
      required: ['chain_id'],
    },
  };
}

/**
 * Run chain tool handler
 */
export async function handleRunChainTool(input: unknown): Promise<string> {
  const { chain_id, payload } = input as {
    chain_id: string;
    payload?: Record<string, unknown>;
  };

  if (!chain_id || chain_id.trim().length === 0) {
    return JSON.stringify({ error: 'chain_id is required' });
  }

  const event = {
    id: `pa-chain-${chain_id}-${Date.now()}`,
    source: 'pocket-agent',
    type: 'chain.manual',
    payload: {
      chain_id,
      ...payload,
      origin: 'pocket-agent',
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(JARVIS_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 202) {
      console.log(`[JarvisTools] Chain triggered: ${chain_id} (${event.id})`);
      return JSON.stringify({
        success: true,
        message: `Chain \`${chain_id}\` triggered successfully`,
        event_id: event.id,
      });
    }

    console.warn(`[JarvisTools] Jarvis returned ${res.status} for chain ${chain_id}`);
    return JSON.stringify({
      success: false,
      message: `Jarvis returned status ${res.status}. The chain may not have been triggered.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JarvisTools] Jarvis unreachable for chain ${chain_id}: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Jarvis is currently offline. The chain will run when Jarvis is back up.',
    });
  }
}

// ---------------------------------------------------------------------------
// jarvis_status
// ---------------------------------------------------------------------------

/**
 * Jarvis status tool definition
 */
export function getJarvisStatusToolDefinition() {
  return {
    name: 'jarvis_status',
    description: 'Check the health and status of the Jarvis daemon. Shows uptime, memory usage, events received, and loaded skills/chains.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * Jarvis status tool handler
 */
export async function handleJarvisStatusTool(_input: unknown): Promise<string> {
  try {
    const res = await fetch(`${JARVIS_BASE_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = await res.json() as Record<string, unknown>;

    // Uptime — brain sends uptime_seconds (number)
    const uptimeSeconds = data.uptime_seconds as number | undefined;
    let uptimeStr = 'unknown';
    if (typeof uptimeSeconds === 'number') {
      const hours = Math.floor(uptimeSeconds / 3600);
      const mins = Math.floor((uptimeSeconds % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    // Memory — brain sends memory_mb (flat number)
    const memoryMb = data.memory_mb as number | undefined;
    const memoryStr = typeof memoryMb === 'number' ? `${memoryMb} MB` : 'unknown';

    // Core counts
    const eventsReceived = data.events_received ?? 'unknown';
    const skillsRegistered = data.skills_registered ?? 'unknown';
    const chainsLoaded = data.chains_loaded ?? 'unknown';
    const retryQueue = data.retry_queue ?? 0;
    const sseConnected = data.sse_connected ?? false;
    const status = data.status ?? 'unknown';
    const version = data.version ?? 'unknown';

    // Self-heal status
    const selfHeal = data.self_heal as Record<string, unknown> | undefined;
    const selfHealSummary = selfHeal ? {
      daily_heals: selfHeal.daily_heals ?? 0,
      healing_active: selfHeal.healing_active ?? false,
      healing_skill: selfHeal.healing_skill ?? null,
      open_breakers: selfHeal.open_breakers ?? [],
    } : undefined;

    return JSON.stringify({
      success: true,
      status,
      version,
      uptime: uptimeStr,
      memory: memoryStr,
      events_received: eventsReceived,
      skills_registered: skillsRegistered,
      chains_loaded: chainsLoaded,
      retry_queue: retryQueue,
      sse_connected: sseConnected,
      self_heal: selfHealSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JarvisTools] Health check failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Jarvis daemon is currently offline.',
    });
  }
}

// ---------------------------------------------------------------------------
// jarvis_journal
// ---------------------------------------------------------------------------

/**
 * Jarvis journal tool definition
 */
export function getJarvisJournalToolDefinition() {
  return {
    name: 'jarvis_journal',
    description: "Fetch today's Jarvis journal entries. Shows chain executions, skill results, and events processed.",
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Optional date in YYYY-MM-DD format. Defaults to today.',
        },
      },
      required: [],
    },
  };
}

/**
 * Jarvis journal tool handler
 */
export async function handleJarvisJournalTool(input: unknown): Promise<string> {
  const { date } = input as { date?: string };

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  try {
    const endpoint = date
      ? `${JARVIS_BASE_URL}/journal/${date}`
      : `${JARVIS_BASE_URL}/journal/today`;

    const res = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = await res.json() as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>> | undefined;

    if (!entries || entries.length === 0) {
      return JSON.stringify({
        success: true,
        message: `No journal entries for ${date ?? 'today'}.`,
        entries: [],
      });
    }

    const formatted = entries.map((entry) => ({
      timestamp: entry.timestamp ?? entry.ts ?? 'unknown',
      chain: entry.chain ?? entry.chain_id ?? 'unknown',
      step: entry.step ?? entry.skill ?? 'unknown',
      status: entry.status ?? 'unknown',
      detail: entry.detail ?? entry.message ?? '',
    }));

    return JSON.stringify({
      success: true,
      count: formatted.length,
      date: date ?? new Date().toISOString().split('T')[0],
      entries: formatted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JarvisTools] Journal fetch failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Could not fetch journal. Jarvis may be offline.',
    });
  }
}

// ---------------------------------------------------------------------------
// jarvis_list_chains
// ---------------------------------------------------------------------------

/**
 * List chains tool definition
 */
export function getListChainsToolDefinition() {
  return {
    name: 'jarvis_list_chains',
    description: 'List all available Jarvis chains. Shows chain IDs, event triggers, descriptions, and step counts.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * List chains tool handler
 */
export async function handleListChainsTool(_input: unknown): Promise<string> {
  try {
    const res = await fetch(`${JARVIS_BASE_URL}/chains`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = await res.json() as Record<string, unknown>;
    const chains = data.chains as Array<Record<string, unknown>> | undefined;

    if (!chains || chains.length === 0) {
      return JSON.stringify({
        success: true,
        message: 'No chains loaded.',
        chains: [],
      });
    }

    const formatted = chains.map((chain) => ({
      chain_id: chain.id ?? chain.chain_id ?? 'unknown',
      event_type: chain.event ?? chain.event_type ?? chain.trigger ?? 'unknown',
      description: chain.description ?? '',
      steps: Array.isArray(chain.steps) ? chain.steps.length : (chain.steps_count ?? 'unknown'),
    }));

    return JSON.stringify({
      success: true,
      count: formatted.length,
      chains: formatted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JarvisTools] Chains fetch failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Could not fetch chains. Jarvis may be offline.',
    });
  }
}

// ---------------------------------------------------------------------------
// jarvis_dispatch_task
// ---------------------------------------------------------------------------

/**
 * Dispatch task tool definition
 */
export function getDispatchTaskToolDefinition() {
  return {
    name: 'jarvis_dispatch_task',
    description: 'Dispatch a Mission Control task to Jarvis for autonomous execution. Jarvis will spawn a Claude Code session to work on the task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The Mission Control task ID to dispatch (e.g., "mc-task-mm6q04gw-a3f1b2c9")',
        },
        project: {
          type: 'string',
          description: 'Optional project name for routing context (e.g., "jarvis", "floe")',
        },
      },
      required: ['task_id'],
    },
  };
}

/**
 * Dispatch task tool handler
 */
export async function handleDispatchTaskTool(input: unknown): Promise<string> {
  const { task_id, project } = input as {
    task_id: string;
    project?: string;
  };

  if (!task_id || task_id.trim().length === 0) {
    return JSON.stringify({ error: 'task_id is required' });
  }

  const event = {
    id: `pa-dispatch-${task_id}-${Date.now()}`,
    source: 'pocket-agent',
    type: 'task.dispatch',
    payload: {
      task_id,
      project,
      origin: 'pocket-agent',
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(JARVIS_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 202) {
      console.log(`[JarvisTools] Task dispatched: ${task_id} (${event.id})`);
      return JSON.stringify({
        success: true,
        message: `Task \`${task_id}\` dispatched to Jarvis${project ? ` (project: ${project})` : ''}`,
        event_id: event.id,
      });
    }

    console.warn(`[JarvisTools] Jarvis returned ${res.status} for task dispatch ${task_id}`);
    return JSON.stringify({
      success: false,
      message: `Jarvis returned status ${res.status}. The task may not have been dispatched.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JarvisTools] Jarvis unreachable for task dispatch ${task_id}: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Jarvis is currently offline. The task will be dispatched when Jarvis is back up.',
    });
  }
}

// ---------------------------------------------------------------------------
// Export all Jarvis tools
// ---------------------------------------------------------------------------

/**
 * Get all Jarvis tools
 */
export function getJarvisTools() {
  return [
    {
      ...getRunChainToolDefinition(),
      handler: handleRunChainTool,
    },
    {
      ...getJarvisStatusToolDefinition(),
      handler: handleJarvisStatusTool,
    },
    {
      ...getJarvisJournalToolDefinition(),
      handler: handleJarvisJournalTool,
    },
    {
      ...getListChainsToolDefinition(),
      handler: handleListChainsTool,
    },
    {
      ...getDispatchTaskToolDefinition(),
      handler: handleDispatchTaskTool,
    },
  ];
}
