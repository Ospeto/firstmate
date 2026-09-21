# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Fleet RPC root validation is centralized in `server/firstmate-root.ts`; any caller-supplied root must resolve to a checkout containing `AGENTS.md` and `bin/fm-session-start.sh` before scripts are executed.
- Quick dispatch enforces the backlog and brief scaffold invariants required by `bin/fm-spawn.sh` before launching workers, and resolves project checkouts under `projects/<name>`.
- Secondmate task logs reside under `${secondmate.home}/state/${taskId}.status`; `server/firstmate.ts` searches registered secondmate homes when a task status log is absent in primary state.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
