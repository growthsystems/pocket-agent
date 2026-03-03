# Pocket Agent

A persistent desktop AI assistant powered by Claude Agent SDK that runs 24/7 as a system tray application with continuous memory, Telegram integration, browser automation, and scheduled task management.

## Project Structure

```
src/
├── main/           # Electron main process (app lifecycle, tray, windows)
├── agent/          # Claude Agent SDK wrapper and orchestration
├── memory/         # SQLite persistence (messages, facts, embeddings)
├── channels/       # Communication channels (Telegram, desktop)
├── scheduler/      # Cron job management
├── browser/        # 2-tier browser automation (Electron + CDP)
├── tools/          # Agent tool implementations
├── config/         # Configuration and identity loading
├── settings/       # User preferences management
├── auth/           # OAuth flows for integrations
├── permissions/    # System permissions handling (macOS)
├── cli/            # Command-line interfaces
├── mcp/            # Model Context Protocol servers
└── skills/         # Skill system for extensibility

ui/                 # HTML interfaces (chat, settings, cron, facts)
tests/unit/         # Vitest unit tests
assets/             # Tray icons and static assets
.claude/            # Claude Code commands and skills
```

## Organization Rules

**Keep code organized by responsibility:**
- Electron main process → `src/main/`
- Agent logic → `src/agent/`
- Persistence → `src/memory/`
- External channels → `src/channels/`
- Tool implementations → `src/tools/`
- Configuration → `src/config/` and `src/settings/`
- Browser automation → `src/browser/`

**Modularity principles:**
- Single responsibility per file
- Clear, descriptive file names
- Group related functionality together
- Avoid monolithic files

## Code Quality - Zero Tolerance

After editing ANY file, run:

```bash
npm run typecheck && npm run lint
```

Fix ALL errors/warnings before continuing.

**Available scripts:**
- `npm run lint` - ESLint check
- `npm run lint:fix` - Auto-fix lint issues
- `npm run typecheck` - TypeScript type checking
- `npm run format` - Prettier auto-format
- `npm run test` - Run all tests

## Key Architecture

**Memory Layer:** SQLite with messages, facts, and embeddings for persistent conversation

**Browser Automation:** Dual-tier system
- Electron tier: Hidden window for JS rendering
- CDP tier: Chrome DevTools Protocol for authenticated sessions

**Channel System:** Abstracts Telegram and desktop UI communication

**Scheduler:** Cron-based task automation with SQLite persistence

## Command Center Integration

This project is managed by **Jarvis** (autonomous agent) and tracked in **Mission Control** (central task registry).

- **Every task MUST have an MC task ID** (`mcTaskId` in frontmatter) — without it, Jarvis can't track or dispatch work
- Agile Boy's `/ab-create-task` auto-registers with MC; `/ab-work-on-it` and `/ab-test-and-complete` PATCH status updates
- MC API: `http://localhost:4000/api/tasks` — Jarvis uses `filePath` to know where each task's spec lives
- To request Jarvis work on a task: post to `#jarvis-commands` in Slack
- Task health in MC is critical — stale or missing tasks break Jarvis's morning briefing, dispatch, and reporting chains

## System Roles

- **Pocket Agent** = eyes, ears, hands (triggers, memory, integrations, UI)
- **Jarvis** = brain (event routing, chain orchestration, skill execution)
- **Mission Control** = scoreboard (task registry, project dashboard)

## Jarvis Integration

Jarvis is the autonomous event-driven daemon that orchestrates work across all projects. Pocket Agent is the primary cron trigger source — its scheduler fires time-based events that Jarvis chains listen for.

### Jarvis Tools Exposed to Claude Agent

Pocket Agent exposes 5 Jarvis-specific tools that users can invoke conversationally (e.g., "run the morning briefing"):

| Tool | Purpose |
|------|---------|
| `jarvis_run_chain` | Trigger a chain manually (POST to `/event`) |
| `jarvis_status` | Check Jarvis daemon health (uptime, memory, events) |
| `jarvis_journal` | Fetch today's Jarvis journal (what chains ran, results) |
| `jarvis_list_chains` | List all available chains with descriptions |
| `jarvis_dispatch_task` | Dispatch a Mission Control task to Jarvis for execution |

### Vault / Memory Integration

Pocket Agent writes persistent memory (facts about the user) to a vault directory. Jarvis reads from this via symlink for user context when routing events.

```
PA writes to:     /Users/vasanth/Documents/Pocket-agent/vault/
Jarvis reads from: /Users/vasanth/Code/command-center/jarvis/vault/ (symlinked)

Vault structure: family/, people/, projects/, preferences/, work/, notes/
```

If the symlink breaks, Jarvis loses user context.

### PA CLI Used by Jarvis

Jarvis skills call the `pocket` CLI binary (Go, installed globally) for real-world integrations. Returns clean JSON for chain parsing.

```bash
pocket comms email list -l 10           # Email briefing
pocket dev github prs                    # PR triage
pocket news hn top -l 5                  # News gathering
pocket comms telegram send "msg"         # Alerts to PA
```

### Endpoints

| Service          | URL                        | Purpose                        |
|------------------|----------------------------|--------------------------------|
| Jarvis Daemon    | `http://localhost:4001`    | Event ingestion, chain runner  |
| Mission Control  | `http://localhost:4000`    | Task registry, SSE stream      |
| MC SSE Stream    | `http://localhost:4000/api/events/stream` | Real-time task events |
| Jarvis Health    | `http://localhost:4001/health` | Health check (uptime, memory, disk, node version) |

### Triggering Events

POST events to Jarvis to trigger chains:

```bash
curl -X POST http://localhost:4001/event \
  -H "Content-Type: application/json" \
  -d '{
    "event": "cron.morning",
    "payload": { "source": "pocket-agent", "timestamp": "2026-03-01T07:00:00Z" }
  }'
```

### Cron Events Pocket Agent Should Fire

These are the time-based events Jarvis chains expect from Pocket Agent's scheduler:

| Event               | Suggested Schedule | Chain              | Description                                          |
|---------------------|--------------------|--------------------|------------------------------------------------------|
| `cron.morning`      | `0 7 * * *`        | morning-briefing   | Daily briefing: email, calendar, open PRs, top tasks |
| `cron.nightly`      | `0 23 * * *`       | nightly-digest     | Accountability digest: journal, what shipped today   |
| `cron.weekly`       | `0 10 * * 1`       | weekly-review      | Weekly review: aggregated journal, tasks, themes     |
| `cron.content-check`| `0 9 * * *`        | content-due        | Check MC for content tasks due in next 24-48 hours   |

### Available Chains

| Chain                | Trigger Event                    | Description                                                      |
|----------------------|----------------------------------|------------------------------------------------------------------|
| health-check         | `system.health-check`            | System health check (uptime, memory, disk)                       |
| video-distribution   | `youtube.video.published`        | Distribute new YouTube video to Discord, social, close MC tasks  |
| article-distribution | `article.published`              | Distribute new article to communities and social                 |
| pr-merged            | `github.pr.merged`               | Close related MC tasks, notify Slack                             |
| deployment-succeeded | `github.deployment.success`      | Close blocked MC tasks, notify                                   |
| deployment-failed    | `github.deployment.failure`      | Alert immediately on deploy failure                              |
| morning-briefing     | `cron.morning`                   | Daily morning briefing (email, calendar, PRs, tasks)             |
| nightly-digest       | `cron.nightly`                   | Nightly accountability digest (journal, shipped today)           |
| weekly-review        | `cron.weekly`                    | Weekly progress review (aggregated journal, patterns)            |
| task-completed       | `mission-control.task.completed` | Notify on task completion (if flagged)                           |
| task-blocked         | `mission-control.task.blocked`   | Alert when a task is blocked                                     |
| content-due          | `cron.content-check`             | Check for content tasks due in 24-48 hours                       |
| video-request        | `video.requested`                | Brand video request flow (MC task, brand task, studio order)     |
| video-status-sync    | `video.status-changed`           | Sync studio order status to MC and brand task                    |
| task-dispatch        | `task.dispatch`                  | Spawn Claude Code session to work on an MC task                  |
| task-batch-dispatch  | `task.batch-dispatch`            | Dispatch all unblocked high-priority tasks sequentially          |
| offer-flow           | `offer.created`                  | Build and distribute an offer (generate, approve, distribute)    |
| project-scanned      | `project.registered`             | Scan new project and build .jarvis/profile.yaml                  |

### Available Skills

Skills are the atomic units Jarvis chains execute:

- `health-check` — System uptime, memory, disk, node version
- `morning-briefing` — Gather email, calendar, open PRs, top MC tasks
- `daily-digest` — Read journal, aggregate completed tasks, summarize patterns
- `weekly-review` — Aggregate week's journal entries, tasks, recurring patterns
- `journal-scanner` — Scan and parse journal entries
- `post-to-community` — Post to a community's Discord channel
- `cross-post-social` — Cross-post to Twitter and LinkedIn
- `close-related-tasks` — Close MC tasks linked to an event (PR, deploy, video)
- `notify-owner` — Send notification to Slack/Telegram
- `check-content-calendar` — Query MC for content tasks due soon
- `create-mc-task` — POST to MC API to create a new task
- `create-brand-task` — Write .md task file in brand's tasks/queue/
- `create-studio-order` — Write order .md in creative-studio/orders/queue/
- `notify-slack` — Post message to a Slack channel
- `offer-builder` — Generate complete offer package using Claude
- `offer-distribute` — Distribute approved offer to target platforms
- `project-scanner` — Auto-detect stack, deploy, CI from project files
- `task-resolver` — Fetch task from MC, resolve filePath to project root
- `task-dispatcher` — Spawn Claude Code session via Agent SDK
- `session-manager` — Manage Claude Code agent sessions

### Integration Status

Pocket Agent's scheduler now fires cron events to Jarvis automatically. When a scheduled job completes and its name matches a known Jarvis trigger (defined in `JARVIS_CRON_MAP` in `src/scheduler/index.ts`), the scheduler POSTs a `JarvisEvent` to `http://localhost:4001/event`. The call is fire-and-forget — Jarvis being offline does not affect scheduler operation.

**To activate:** Create cron jobs in Pocket Agent with names matching the map keys: `morning-briefing`, `nightly-digest`, `weekly-review`, `content-check`, `health-check`.
