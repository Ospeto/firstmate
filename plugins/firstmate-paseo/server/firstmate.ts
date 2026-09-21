import type { RpcInput } from "@getpaseo/plugin";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { backlogRpc, fleetStatusRpc, taskLogsRpc } from "../shared/firstmate";
import { assertFirstmateRoot } from "./firstmate-root";
import { classifyTaskHealth, triagePr, type TaskHealthVerdict, type PrTriageVerdict } from "./jev";
import { getJevStats } from "./stats";

export async function getTaskLogs(input: RpcInput<typeof taskLogsRpc>) {
  const root = assertFirstmateRoot(input.firstmateRoot);
  const taskId = input.taskId;
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return { taskId, lines: [], totalLines: 0 };
  }

  const stateDir = resolve(root, "state");
  const maxLines = input.lines ?? 15;

  let statusPath = resolve(stateDir, `${taskId}.status`);
  if (!existsSync(statusPath)) {
    // Check registered secondmate homes if absent in primary stateDir
    const secondmatesFile = resolve(root, "data", "secondmates.md");
    let found = false;
    if (existsSync(secondmatesFile)) {
      try {
        const content = readFileSync(secondmatesFile, "utf8");
        for (const line of content.split("\n")) {
          const homeMatch = line.match(/\bhome:\s*([^;)]+)/);
          if (homeMatch) {
            const smHome = homeMatch[1].trim();
            const candidate = resolve(smHome, "state", `${taskId}.status`);
            if (existsSync(candidate)) {
              statusPath = candidate;
              found = true;
              break;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
    if (!found) {
      return { taskId, lines: [], totalLines: 0 };
    }
  }

  try {
    const content = readFileSync(statusPath, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    const totalLines = allLines.length;
    const tail = allLines.slice(-maxLines);
    return { taskId: input.taskId, lines: tail, totalLines };
  } catch {
    return { taskId: input.taskId, lines: [], totalLines: 0 };
  }
}

type FleetSecondmate = {
  id: string;
  state: string;
  host: string | null;
  scope: string;
  home: string | null;
};

type RawTask = {
  id: string;
  name: string;
  kind: string;
  status: string;
  prUrl: string | null;
  doing: string | null;
  recentLog: string;
  secondmate: string | null;
  host: string | null;
};

function statusFromLine(line: string): string {
  if (/^working(?:\s|:)/i.test(line)) return "working";
  if (/^needs-decision(?:\s|:)/i.test(line)) return "needs-decision";
  if (/^blocked(?:\s|:)/i.test(line)) return "blocked";
  if (/^(?:done|resolved)(?:\s|:)/i.test(line)) return "done";
  return "unknown";
}

function extractPrUrl(line: string): string | null {
  const match = line.match(/https:\/\/github\.com\/[^\s)]+/i);
  return match ? match[0].replace(/[.,;]+$/, "") : null;
}

const STOP_WORDS = new Set([
  "is",
  "exit",
  "not",
  "running",
  "was",
  "has",
  "process",
  "dead",
  "worktree",
  "endpoint",
  "task",
  "worker",
  "can",
  "will",
  "would",
  "could",
  "should",
  "did",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "of",
  "and",
  "or",
  "a",
  "an",
  "the",
  "session",
  "state",
  "error",
  "done",
  "working",
  "blocked",
]);

function childIdFromLine(line: string): string | null {
  // 1. Explicit child status line: child <id> (done|working|blocked|needs-decision|PR ready|launched|spawned)
  const childMatch = line.match(
    /\bchild\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+(?:done|working|blocked|needs-decision|PR ready|launched|spawned|status:)/i,
  );
  if (childMatch && !STOP_WORDS.has(childMatch[1].toLowerCase())) {
    return childMatch[1];
  }

  // 2. Spawned or dispatched worker <id>
  const spawnedMatch = line.match(
    /\b(?:Spawned and dispatched|dispatched(?:\s+isolated)?(?:\s+direct-PR)?\s+worker)\s+([A-Za-z0-9][A-Za-z0-9_-]*)\b/i,
  );
  if (spawnedMatch && !STOP_WORDS.has(spawnedMatch[1].toLowerCase())) {
    return spawnedMatch[1];
  }

  // 3. Structured key in status event: [key=child-(outcome-|pr-)?<id>]
  const keyMatch = line.match(
    /\[key=child-(?:outcome-|pr-)?([a-zA-Z0-9_-]+)\]/i,
  );
  if (keyMatch) {
    const cleanId = keyMatch[1].replace(/-(?:done|working|blocked|ready)(?:-[a-f0-9]+)?$/i, "");
    if (!STOP_WORDS.has(cleanId.toLowerCase())) {
      return cleanId;
    }
  }

  return null;
}

function parseChildTasks(statusContent: string, secondmate: FleetSecondmate): RawTask[] {
  const byId = new Map<string, RawTask>();
  const lines = statusContent.split("\n").filter(Boolean);

  for (const line of lines) {
    const id = childIdFromLine(line);
    if (!id) continue;

    const prUrl = extractPrUrl(line);
    const status = /\b(?:Spawned and dispatched|dispatched(?:\s+isolated)?(?:\s+direct-PR)?\s+worker)\b/i.test(line)
      ? "working"
      : statusFromLine(line);
    const previous = byId.get(id);
    const recentLines = [...(previous?.recentLog ? previous.recentLog.split("\n") : []), line].slice(-5);

    byId.set(id, {
      id,
      name: id,
      kind: prUrl || /direct-PR/i.test(line) ? "ship" : "scout",
      status: status === "unknown" && previous ? previous.status : status,
      prUrl: prUrl ?? previous?.prUrl ?? null,
      doing: line,
      recentLog: recentLines.join("\n"),
      secondmate: secondmate.id,
      host: secondmate.host,
    });
  }

  return Array.from(byId.values());
}

function readMetaTasks(
  stateDir: string,
  secondmate: FleetSecondmate | null,
  excludedIds: Set<string> = new Set(),
): RawTask[] {
  const tasks: RawTask[] = [];
  if (!existsSync(stateDir)) return tasks;

  for (const file of readdirSync(stateDir)) {
    if (!file.endsWith(".meta") || file.startsWith(".")) continue;
    const taskId = file.slice(0, -5);
    if (secondmate?.id === taskId || excludedIds.has(taskId)) continue;

    try {
      const metaContent = readFileSync(resolve(stateDir, file), "utf8");
      const kindMatch = metaContent.match(/^kind=(.*)$/m);
      const prMatch = metaContent.match(/^pr=(.*)$/m);
      const kind = kindMatch ? kindMatch[1].trim() : "ship";
      const rawPrUrl = prMatch ? prMatch[1].trim() : "";
      const prUrl = rawPrUrl && rawPrUrl !== "-" ? rawPrUrl : null;

      let doing: string | null = null;
      let status = "unknown";
      let recentLog = "";
      const statusPath = resolve(stateDir, `${taskId}.status`);
      if (existsSync(statusPath)) {
        const statusLines = readFileSync(statusPath, "utf8").trim().split("\n").filter(Boolean);
        if (statusLines.length > 0) {
          recentLog = statusLines.slice(-5).join("\n");
          doing = statusLines[statusLines.length - 1];
          status = statusFromLine(doing);
        }
      }

      tasks.push({
        id: taskId,
        name: taskId,
        kind,
        status,
        prUrl,
        doing,
        recentLog,
        secondmate: secondmate?.id ?? null,
        host: secondmate?.host ?? null,
      });
    } catch {
      // Ignore individual meta read errors.
    }
  }

  return tasks;
}

type BacklogItem = {
  id: string;
  title: string;
  status: string;
  repo?: string;
  priority?: string;
  blockedBy?: string[];
  note?: string;
  heldReason?: string;
};

/**
 * Parse TOON table rows from tasks-axi list output.
 * Expected header: tasks[N]{id,state,...}:
 * Each data row is comma-separated with quoted strings for fields containing commas.
 */
function parseToonTableRows(
  output: string,
  limit: number,
): BacklogItem[] {
  const items: BacklogItem[] = [];
  const lines = output.split("\n");

  // Find the table header to extract column names
  let columns: string[] = [];
  let dataStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^tasks\[\d+\]\{([^}]+)\}:/);
    if (headerMatch) {
      columns = headerMatch[1].split(",").map((c) => c.trim());
      dataStart = i + 1;
      break;
    }
  }

  if (dataStart < 0 || columns.length === 0) return items;

  const idIdx = columns.indexOf("id");
  const stateIdx = columns.indexOf("state");
  const titleIdx = columns.indexOf("title");
  const repoIdx = columns.indexOf("repo");
  const blockedByIdx = columns.indexOf("blocked_by");
  const priorityIdx = columns.indexOf("priority");
  const heldIdx = columns.indexOf("held");
  const holdReasonIdx = columns.indexOf("hold_reason");

  for (let i = dataStart; i < lines.length && items.length < limit; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("help[") || line.startsWith("count:")) break;

    // Parse comma-separated values respecting quoted strings
    const values: string[] = [];
    let current = "";
    let inQuote = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"' && (c === 0 || line[c - 1] !== "\\")) {
        inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        values.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    if (idIdx < 0 || stateIdx < 0 || titleIdx < 0) continue;
    if (values.length <= Math.max(idIdx, stateIdx, titleIdx)) continue;

    const state = values[stateIdx];
    // Skip done and in_flight - those are already shown in fleet view
    if (state === "done" || state === "in_flight") continue;

    const repoRaw = repoIdx >= 0 ? values[repoIdx] : undefined;
    const repo = repoRaw && repoRaw !== "-" ? repoRaw : undefined;

    const blockedByRaw = blockedByIdx >= 0 ? values[blockedByIdx] : "";
    const blockedBy =
      blockedByRaw && blockedByRaw !== "none" && blockedByRaw !== "-"
        ? blockedByRaw.split(/[;|+]/).map((s) => s.trim()).filter(Boolean)
        : undefined;

    const priorityRaw = priorityIdx >= 0 ? values[priorityIdx] : undefined;
    const priority = priorityRaw && priorityRaw !== "-" ? priorityRaw : undefined;

    const isHeld = heldIdx >= 0 && values[heldIdx] === "yes";
    const holdReasonRaw = holdReasonIdx >= 0 ? values[holdReasonIdx] : undefined;
    const heldReason =
      isHeld && holdReasonRaw && holdReasonRaw !== "-"
        ? holdReasonRaw.replace(/^"(.*)"$/, "$1")
        : undefined;

    let status: string;
    if (isHeld) {
      status = "held";
    } else if (blockedBy && blockedBy.length > 0) {
      status = "blocked";
    } else {
      status = "queued";
    }

    items.push({
      id: values[idIdx],
      title: values[titleIdx].replace(/^"(.*)"$/, "$1").replace(/\\n\.\.\. \(truncated.*$/, "..."),
      status,
      repo,
      priority,
      blockedBy,
      heldReason,
    });
  }

  return items;
}

/**
 * Fallback parser for data/backlog.md when tasks-axi is unavailable.
 * Reads unchecked items (- [ ]) from ## Queued section, skipping ## Done and ## In flight.
 */
function parseBacklogMarkdown(content: string, limit: number): BacklogItem[] {
  const items: BacklogItem[] = [];
  const lines = content.split("\n");
  let inQueued = false;

  for (const line of lines) {
    if (items.length >= limit) break;

    if (/^## Queued/.test(line)) {
      inQueued = true;
      continue;
    }
    if (/^## /.test(line)) {
      inQueued = false;
      continue;
    }

    if (!inQueued) continue;

    // Match unchecked task lines: - [ ] id - title (metadata)
    const match = line.match(
      /^- \[ \] ([^\s]+)\s+-\s+(.*?)(?:\s+\((?:repo|kind|since)[^)]*\))*\s*$/,
    );
    if (!match) continue;

    const repoMatch = line.match(/\(repo:\s*([^)]+)\)/);
    const repo = repoMatch ? repoMatch[1].trim() : undefined;

    items.push({
      id: match[1],
      title: match[2].trim(),
      status: "queued",
      repo,
    });
  }

  return items;
}

export function getBacklog(input: RpcInput<typeof backlogRpc>) {
  const root = assertFirstmateRoot(input.firstmateRoot);
  const limit = input.limit ?? 50;

  // Try tasks-axi first
  try {
    const axiScript = resolve(root, "bin/fm-tasks-axi.sh");
    if (existsSync(axiScript)) {
      const output = execSync(
        `"${axiScript}" list --fields blocked_by,priority,held,hold_reason`,
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, FM_ROOT: root },
        },
      );
      const items = parseToonTableRows(output, limit);
      return { items };
    }
  } catch {
    // Fall through to markdown fallback
  }

  // Fallback: parse data/backlog.md directly
  try {
    const backlogPath = resolve(root, "data/backlog.md");
    if (existsSync(backlogPath)) {
      const content = readFileSync(backlogPath, "utf8");
      return { items: parseBacklogMarkdown(content, limit) };
    }
  } catch {
    // Return empty on failure
  }

  return { items: [] };
}

export async function getFleetStatus(input: RpcInput<typeof fleetStatusRpc>) {
  const root = assertFirstmateRoot(input.firstmateRoot);
  const stateDir = resolve(root, "state");
  const dataDir = resolve(root, "data");

  let lockHolder: string | null = null;
  let isHelm = false;
  try {
    const lockPath = resolve(stateDir, ".lock");
    if (existsSync(lockPath)) {
      lockHolder = readFileSync(lockPath, "utf8").trim() || null;
    }
  } catch {
    // Ignore read errors
  }

  const currentPid = String(process.pid);
  if (lockHolder && (lockHolder === currentPid || lockHolder === process.env.FM_LOCK_HELD_PID)) {
    isHelm = true;
  }

  // 1. Authoritative registered projects from data/projects.md
  const projects: Array<{ name: string; posture: string; description: string }> = [];
  try {
    const projectsFile = resolve(dataDir, "projects.md");
    if (existsSync(projectsFile)) {
      const content = readFileSync(projectsFile, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^-\s+([^\s]+)(?:\s+\[(.*?)\])?\s+-\s+(.*)$/);
        if (match) {
          projects.push({
            name: match[1],
            posture: match[2] || "no-mistakes",
            description: match[3],
          });
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  // 2. Authoritative secondmates from data/secondmates.md
  const secondmatesMap = new Map<string, FleetSecondmate>();
  try {
    const secondmatesFile = resolve(dataDir, "secondmates.md");
    if (existsSync(secondmatesFile)) {
      const content = readFileSync(secondmatesFile, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^-\s+([a-zA-Z0-9_-]+)\s+-\s+(.*?)(?:\s+\((.*?)\))?$/);
        if (match) {
          const id = match[1];
          const desc = match[2];
          const paren = match[3] || "";
          let host = "local";
          let scope = desc;
          let home: string | null = null;
          if (paren) {
            const hostMatch = paren.match(/host:\s*([a-zA-Z0-9_-]+)/);
            if (hostMatch) host = hostMatch[1];
            const scopeMatch = paren.match(/scope:\s*([^;]+)/);
            if (scopeMatch) scope = scopeMatch[1].trim();
            const homeMatch = paren.match(/home:\s*([^;)]+)/);
            if (homeMatch) home = homeMatch[1].trim();
          }

          // Check status log for latest secondmate activity.
          let state = "idle";
          try {
            const statusPath = resolve(stateDir, `${id}.status`);
            if (existsSync(statusPath)) {
              const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean);
              if (statusLines.length > 0) {
                const latestStatus = statusFromLine(statusLines[statusLines.length - 1]);
                state = latestStatus === "unknown" ? "alive" : latestStatus;
              }
            }
          } catch {
            // Ignore status read errors.
          }

          secondmatesMap.set(id, { id, state, host, scope, home });
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  // 3. Scan the primary home and any locally mounted secondmate homes.
  const rawTasks: RawTask[] = [];
  const seenTaskIds = new Set<string>();
  const addTasks = (tasks: RawTask[]) => {
    for (const task of tasks) {
      if (seenTaskIds.has(task.id)) continue;
      seenTaskIds.add(task.id);
      rawTasks.push(task);
    }
  };

  try {
    addTasks(readMetaTasks(stateDir, null, new Set(secondmatesMap.keys())));
  } catch {
    // Ignore primary state directory errors.
  }

  for (const secondmate of secondmatesMap.values()) {
    if (!secondmate.home || !existsSync(secondmate.home)) continue;
    try {
      addTasks(readMetaTasks(resolve(secondmate.home, "state"), secondmate));
    } catch {
      // Ignore unavailable local secondmate homes.
    }
  }

  // Cached primary status logs are also the source of truth for remote child workers.
  for (const secondmate of secondmatesMap.values()) {
    try {
      const statusPath = resolve(stateDir, `${secondmate.id}.status`);
      if (!existsSync(statusPath)) continue;
      const childTasks = parseChildTasks(readFileSync(statusPath, "utf8"), secondmate);
      addTasks(childTasks);
      if (childTasks.some((task) => task.status === "working")) {
        secondmate.state = "active_child_work";
      }
    } catch {
      // Ignore unavailable secondmate logs.
    }
  }

  // 4. Jev System-1 classification in parallel for active tasks
  const candidateTasks = input.hideDone
    ? rawTasks.filter((t) => t.status !== "done")
    : rawTasks;

  let activeTasks = await Promise.all(
    candidateTasks.map(async (t) => {
      let health: TaskHealthVerdict | null = null;
      let prTriage: PrTriageVerdict | null = null;

      const healthPromise = t.recentLog ? classifyTaskHealth(t.id, t.recentLog, root) : Promise.resolve(null);
      const prPromise = t.prUrl
        ? triagePr(t.name, t.doing || t.name, root, t.prUrl)
        : Promise.resolve(null);

      const [hRes, pRes] = await Promise.all([healthPromise, prPromise]);
      health = hRes;
      prTriage = pRes;

      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        status: t.status,
        prUrl: t.prUrl,
        doing: t.doing,
        secondmate: t.secondmate,
        host: t.host,
        health,
        prTriage,
      };
    }),
  );

  if (input.hideDone) {
    activeTasks = activeTasks.filter(
      (task) => task.status !== "done" && task.health?.status !== "done",
    );
  }

  // 5. Try bounded snapshot to enrich recent landed
  let recentLanded: Array<{ id: string; what: string; artifact: string; owner: string }> = [];
  try {
    const snapshotRaw = execSync("bin/fm-bearings-snapshot.sh --json", {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
    });
    const snapshotJson = JSON.parse(snapshotRaw);

    if (snapshotJson?.landed && Array.isArray(snapshotJson.landed)) {
      for (const item of snapshotJson.landed) {
        recentLanded.push({
          id: item.id,
          what: item.what || item.id,
          artifact: item.artifact || "-",
          owner: item.owner || "(main)",
        });
      }
    }
  } catch {
    // Fallback if snapshot times out or is refused (e.g. away mode gate)
  }

  // Fallback: parse data/backlog.md ## Done section when bearings snapshot is empty
  if (recentLanded.length === 0) {
    try {
      const backlogPath = resolve(root, "data/backlog.md");
      if (existsSync(backlogPath)) {
        const content = readFileSync(backlogPath, "utf8");
        const doneLines = content.split("\n");
        let inDone = false;
        for (const line of doneLines) {
          if (recentLanded.length >= 10) break;
          if (/^## Done/.test(line)) {
            inDone = true;
            continue;
          }
          if (/^## /.test(line)) {
            inDone = false;
            continue;
          }
          if (!inDone) continue;
          const match = line.match(
            /^- \[x\]\s+([^\s]+)\s+-\s+(.*?)(?:\s+\((?:repo|kind|done|merged)[^)]*\))*\s*$/,
          );
          if (match) {
            const prMatch = line.match(/https:\/\/github\.com\/[^\s)]+/i);
            recentLanded.push({
              id: match[1],
              what: match[2].replace(/^"(.*)"$/, "$1").slice(0, 70),
              artifact: prMatch ? prMatch[0] : "-",
              owner: "(main)",
            });
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return {
    home: root,
    lockHolder,
    isHelm,
    generatedAt: new Date().toISOString(),
    projects,
    secondmates: Array.from(secondmatesMap.values()),
    activeTasks,
    recentLanded,
    jevStats: getJevStats(),
  };
}
