/**
 * Mission Control (MC) task tools for the agent
 *
 * - mc_tasks: Query tasks by program, project, or status
 * - mc_task_detail: Get full details for a specific task
 * - mc_projects: List all projects with task counts
 * - mc_update_task: Update task status
 *
 * Understands program-to-project mapping so the user can say
 * "tasks in media house" and get results across creative-studio + outbound.
 */

import { PROJECT_TO_PROGRAM, PROGRAM_CHANNELS } from '../channels/slack/index';

const MC_BASE_URL = 'http://localhost:4000/api';
const REQUEST_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Reverse mapping: program → project keys
// ---------------------------------------------------------------------------

const PROGRAM_TO_PROJECTS: Record<string, string[]> = {};
for (const [project, program] of Object.entries(PROJECT_TO_PROGRAM)) {
  if (!PROGRAM_TO_PROJECTS[program]) {
    PROGRAM_TO_PROJECTS[program] = [];
  }
  PROGRAM_TO_PROJECTS[program].push(project);
}

/**
 * All known program names for fuzzy matching.
 */
const ALL_PROGRAMS = Object.keys(PROGRAM_CHANNELS);

/**
 * Fuzzy-resolve a user query to a program key.
 * Handles "media house" → "media-house", "content flywheel" → "content-flywheel", etc.
 */
function resolveProgram(query: string): string | undefined {
  const normalised = query.toLowerCase().trim().replace(/\s+/g, '-');

  // Exact match first
  if (ALL_PROGRAMS.includes(normalised)) return normalised;

  // Partial / contains match
  const match = ALL_PROGRAMS.find(
    (p) => p.includes(normalised) || normalised.includes(p),
  );
  return match;
}

/**
 * Resolve a user query (program name, project name, or free text) into MC project IDs.
 * Returns { projectIds, resolvedAs } or null if nothing matched.
 */
async function resolveQueryToProjectIds(
  query: string,
): Promise<{ projectIds: string[]; resolvedAs: string; projectNames: string[] } | null> {
  // 1. Try as program name
  const program = resolveProgram(query);
  if (program) {
    const projectKeys = PROGRAM_TO_PROJECTS[program] ?? [];
    if (projectKeys.length > 0) {
      const projects = await fetchProjects();
      const matched = projects.filter((p) =>
        projectKeys.some(
          (key) => p.name.toLowerCase() === key.toLowerCase() || p.name.toLowerCase().includes(key.toLowerCase()),
        ),
      );
      if (matched.length > 0) {
        return {
          projectIds: matched.map((p) => p.id),
          resolvedAs: `program "${program}" (projects: ${matched.map((p) => p.name).join(', ')})`,
          projectNames: matched.map((p) => p.name),
        };
      }
    }
  }

  // 2. Try as exact project name
  const projects = await fetchProjects();
  const directMatch = projects.find(
    (p) => p.name.toLowerCase() === query.toLowerCase().trim(),
  );
  if (directMatch) {
    return {
      projectIds: [directMatch.id],
      resolvedAs: `project "${directMatch.name}"`,
      projectNames: [directMatch.name],
    };
  }

  // 3. Fuzzy project name match
  const fuzzyMatch = projects.find(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase().trim()) ||
      query.toLowerCase().trim().includes(p.name.toLowerCase()),
  );
  if (fuzzyMatch) {
    return {
      projectIds: [fuzzyMatch.id],
      resolvedAs: `project "${fuzzyMatch.name}"`,
      projectNames: [fuzzyMatch.name],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface MCProject {
  id: string;
  name: string;
  path: string;
  color: string;
  agentCount: number;
  taskCount: number;
}

interface MCTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  projectId: string;
  projectName?: string;
  projectColor?: string;
  assignedAgentName?: string | null;
  storyPoints?: number;
  summary?: string | null;
  filePath?: string | null;
  localTaskId?: string | null;
  epic?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

async function fetchProjects(): Promise<MCProject[]> {
  const res = await fetch(`${MC_BASE_URL}/projects`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json()) as { data: MCProject[] };
  return body.data ?? [];
}

async function fetchTasks(params: Record<string, string> = {}): Promise<MCTask[]> {
  const query = new URLSearchParams(params);
  const url = query.toString() ? `${MC_BASE_URL}/tasks?${query}` : `${MC_BASE_URL}/tasks`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json()) as { data: MCTask[]; meta?: { total?: number } };
  return body.data ?? [];
}

// ---------------------------------------------------------------------------
// mc_tasks
// ---------------------------------------------------------------------------

export function getMcTasksToolDefinition() {
  return {
    name: 'mc_tasks',
    description:
      'Query Mission Control tasks. Can filter by program name (e.g., "media house", "video hub", "content flywheel"), ' +
      'project name (e.g., "creative-studio", "learnloop"), or status (e.g., "in_progress", "registered", "completed"). ' +
      'Programs are groups of related projects — "media house" includes creative-studio and outbound.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Program or project name to filter by (e.g., "media house", "creative-studio", "video hub", "communities")',
        },
        status: {
          type: 'string',
          description:
            'Filter by task status: "registered" (pending), "in_progress" (WIP), "completed", "failed". Leave empty for all.',
          enum: ['registered', 'in_progress', 'completed', 'failed', ''],
        },
      },
      required: [],
    },
  };
}

export async function handleMcTasksTool(input: unknown): Promise<string> {
  const { query, status } = input as { query?: string; status?: string };

  try {
    let tasks: MCTask[];
    let resolvedLabel = 'all projects';

    if (query) {
      const resolution = await resolveQueryToProjectIds(query);
      if (!resolution) {
        // Fallback: fetch all and let the user know
        return JSON.stringify({
          success: false,
          message: `Could not find a program or project matching "${query}". Known programs: ${ALL_PROGRAMS.join(', ')}`,
        });
      }

      resolvedLabel = resolution.resolvedAs;

      // Fetch tasks for each resolved project
      const allTasks: MCTask[] = [];
      for (const projectId of resolution.projectIds) {
        const params: Record<string, string> = { projectId };
        if (status) params.status = status;
        const projectTasks = await fetchTasks(params);
        allTasks.push(...projectTasks);
      }
      tasks = allTasks;
    } else {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      tasks = await fetchTasks(params);
    }

    // Sort by priority descending, then by updated date
    tasks.sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5));

    const formatted = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      project: t.projectName ?? 'unknown',
      assigned_to: t.assignedAgentName ?? 'unassigned',
      story_points: t.storyPoints ?? 1,
      updated: t.updatedAt,
    }));

    const statusSummary: Record<string, number> = {};
    for (const t of tasks) {
      statusSummary[t.status] = (statusSummary[t.status] ?? 0) + 1;
    }

    return JSON.stringify({
      success: true,
      resolved: resolvedLabel,
      total: formatted.length,
      status_summary: statusSummary,
      tasks: formatted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[MCTools] Tasks query failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Mission Control is unreachable. Is it running on port 4000?',
    });
  }
}

// ---------------------------------------------------------------------------
// mc_task_detail
// ---------------------------------------------------------------------------

export function getMcTaskDetailToolDefinition() {
  return {
    name: 'mc_task_detail',
    description:
      'Get full details for a specific Mission Control task by ID. Shows title, status, priority, summary, file path, assigned agent, and more.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The MC task ID (e.g., "mc-task-mm6q04gw-a3f1b2c9")',
        },
      },
      required: ['task_id'],
    },
  };
}

export async function handleMcTaskDetailTool(input: unknown): Promise<string> {
  const { task_id } = input as { task_id: string };

  if (!task_id || task_id.trim().length === 0) {
    return JSON.stringify({ error: 'task_id is required' });
  }

  try {
    const res = await fetch(`${MC_BASE_URL}/tasks/${encodeURIComponent(task_id)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return JSON.stringify({
        success: false,
        message: `Task "${task_id}" not found in Mission Control.`,
      });
    }

    const body = (await res.json()) as { data: MCTask };
    const t = body.data;

    return JSON.stringify({
      success: true,
      task: {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.projectName ?? 'unknown',
        assigned_to: t.assignedAgentName ?? 'unassigned',
        story_points: t.storyPoints ?? 1,
        summary: t.summary ?? null,
        file_path: t.filePath ?? null,
        local_task_id: t.localTaskId ?? null,
        epic: t.epic ?? null,
        created: t.createdAt,
        updated: t.updatedAt,
        completed: t.completedAt ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[MCTools] Task detail failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Mission Control is unreachable. Is it running on port 4000?',
    });
  }
}

// ---------------------------------------------------------------------------
// mc_projects
// ---------------------------------------------------------------------------

export function getMcProjectsToolDefinition() {
  return {
    name: 'mc_projects',
    description:
      'List all projects in Mission Control with task counts and agent counts. ' +
      'Also shows which program each project belongs to.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function handleMcProjectsTool(_input: unknown): Promise<string> {
  try {
    const projects = await fetchProjects();

    const formatted = projects.map((p) => {
      const program =
        PROJECT_TO_PROGRAM[p.name.toLowerCase()] ??
        PROJECT_TO_PROGRAM[p.name.toLowerCase().replace(/\s+/g, '-')] ??
        'unassigned';

      return {
        id: p.id,
        name: p.name,
        program,
        task_count: p.taskCount,
        agent_count: p.agentCount,
      };
    });

    // Group by program for summary
    const programSummary: Record<string, { projects: string[]; total_tasks: number }> = {};
    for (const p of formatted) {
      if (!programSummary[p.program]) {
        programSummary[p.program] = { projects: [], total_tasks: 0 };
      }
      programSummary[p.program].projects.push(p.name);
      programSummary[p.program].total_tasks += p.task_count;
    }

    return JSON.stringify({
      success: true,
      total_projects: formatted.length,
      program_summary: programSummary,
      projects: formatted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[MCTools] Projects query failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Mission Control is unreachable. Is it running on port 4000?',
    });
  }
}

// ---------------------------------------------------------------------------
// mc_update_task
// ---------------------------------------------------------------------------

export function getMcUpdateTaskToolDefinition() {
  return {
    name: 'mc_update_task',
    description:
      'Update a Mission Control task — change status, assigned agent, priority, or summary.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The MC task ID to update',
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['registered', 'in_progress', 'completed', 'failed'],
        },
        assigned_agent: {
          type: 'string',
          description: 'Agent name to assign (e.g., "artisan", "claude")',
        },
        priority: {
          type: 'number',
          description: 'Priority 1-10 (10 = highest)',
        },
        summary: {
          type: 'string',
          description: 'Updated task summary',
        },
      },
      required: ['task_id'],
    },
  };
}

export async function handleMcUpdateTaskTool(input: unknown): Promise<string> {
  const { task_id, status, assigned_agent, priority, summary } = input as {
    task_id: string;
    status?: string;
    assigned_agent?: string;
    priority?: number;
    summary?: string;
  };

  if (!task_id || task_id.trim().length === 0) {
    return JSON.stringify({ error: 'task_id is required' });
  }

  const patch: Record<string, unknown> = {};
  if (status) patch.status = status;
  if (assigned_agent) patch.assignedAgentName = assigned_agent;
  if (priority !== undefined) patch.priority = priority;
  if (summary) patch.summary = summary;

  if (Object.keys(patch).length === 0) {
    return JSON.stringify({ error: 'No fields to update. Provide at least one of: status, assigned_agent, priority, summary.' });
  }

  try {
    const res = await fetch(`${MC_BASE_URL}/tasks/${encodeURIComponent(task_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return JSON.stringify({
        success: false,
        message: `Task "${task_id}" not found.`,
      });
    }

    const body = (await res.json()) as { data: MCTask };
    const t = body.data;

    return JSON.stringify({
      success: true,
      message: `Task "${t.title}" updated successfully.`,
      task: {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigned_to: t.assignedAgentName ?? 'unassigned',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[MCTools] Task update failed: ${msg}`);
    return JSON.stringify({
      success: false,
      message: 'Mission Control is unreachable. Is it running on port 4000?',
    });
  }
}

// ---------------------------------------------------------------------------
// Export all MC tools
// ---------------------------------------------------------------------------

export function getMcTools() {
  return [
    {
      ...getMcTasksToolDefinition(),
      handler: handleMcTasksTool,
    },
    {
      ...getMcTaskDetailToolDefinition(),
      handler: handleMcTaskDetailTool,
    },
    {
      ...getMcProjectsToolDefinition(),
      handler: handleMcProjectsTool,
    },
    {
      ...getMcUpdateTaskToolDefinition(),
      handler: handleMcUpdateTaskTool,
    },
  ];
}
