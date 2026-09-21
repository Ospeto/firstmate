import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { sanitizeFirstmateRoot } from "./firstmate-root";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SHELL_SYNTAX_PATTERN = /[;&|`$><()\[\]{}!\\'"\n\r]/;
const MAX_CACHE_ENTRIES = 100;

type CacheEntry<T> = { value: T; expiresAt: number };

export interface TaskHealthVerdict {
  status: "progressing" | "stuck_looping" | "waiting_user" | "done";
  confidence: number;
}

export interface PrTriageVerdict {
  verdict: "auto_pass" | "oracle_audit";
  confidence: number;
}

export interface PermissionArbiterResult {
  allow: boolean;
  reason: string;
}

export interface ModelRoutingResult {
  model: string;
  thinkingOptionId?: string;
  reason: string;
}

// In-memory cache to avoid calling Jev repeatedly on identical states
const healthCache = new Map<string, CacheEntry<TaskHealthVerdict>>();
const prTriageCache = new Map<string, CacheEntry<PrTriageVerdict>>();
const permissionCache = new Map<string, CacheEntry<PermissionArbiterResult>>();

function stableFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Remove credentials and secret material before any text reaches Jev. */
export function scrubSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/\bapikey_[A-Za-z0-9][A-Za-z0-9_-]{8,}/gi, "[REDACTED_API_KEY]")
    .replace(
      /([?&](?:api[_-]?key|apikey|token|password)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^\r\n]+$/gm,
      "$1=[REDACTED]",
    );
}

function explicitCommand(request: AgentPermissionRequest): string | null {
  const input = request.input as Record<string, unknown> | undefined;
  if (input && typeof input.command === "string") return input.command;
  if (input && typeof input.cmd === "string") return input.cmd;
  if (input && typeof input.commandLine === "string") return input.commandLine;
  if (input && typeof input.command_line === "string") return input.command_line;
  if (input && typeof input.shellCommand === "string") return input.shellCommand;
  if (input && typeof input.shell_command === "string") return input.shell_command;
  const detail = request.detail as Record<string, unknown> | undefined;
  if (detail && typeof detail.command === "string") return detail.command;
  if (detail && typeof detail.commandLine === "string") return detail.commandLine;
  if (detail && typeof detail.command_line === "string") return detail.command_line;
  return null;
}

function getBoundedCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setBoundedCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
): void {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }

  // Delete first so replacing an entry also makes it the newest entry.
  cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

export function getJevCacheSizes(): {
  health: number;
  prTriage: number;
  permission: number;
} {
  return {
    health: healthCache.size,
    prTriage: prTriageCache.size,
    permission: permissionCache.size,
  };
}

function hasUnsafeShellSyntax(command: string): boolean {
  return SHELL_SYNTAX_PATTERN.test(command);
}

export function hasAnyUnsafeShellSyntax(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return hasUnsafeShellSyntax(current);
    if (current === null || typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    for (const key of Reflect.ownKeys(current)) {
      if (visit((current as Record<PropertyKey, unknown>)[key])) return true;
    }
    return false;
  };

  return visit(value);
}

function isStrictSafeStandaloneCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || hasUnsafeShellSyntax(trimmed)) return false;
  return new Set([
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git rev-parse",
    "git ls-files",
    "npm test",
    "npm run test",
    "npm run typecheck",
    "npm run lint",
    "bun test",
    "bun run test",
    "bun run typecheck",
    "bun run lint",
    "pnpm test",
    "pnpm run test",
    "pnpm run typecheck",
    "pnpm run lint",
    "yarn test",
    "yarn run test",
    "yarn run typecheck",
    "yarn run lint",
    "tsc",
    "tsc --noEmit",
    "ls",
    "dir",
    "pwd",
    "whoami",
    "node -v",
    "node --version",
    "bun -v",
    "bun --version",
  ]).has(trimmed.replace(/\s+/g, " "));
}

export function clearJevCaches(): void {
  healthCache.clear();
  prTriageCache.clear();
  permissionCache.clear();
}

export function resolveApiKey(firstmateRoot?: string): string | null {
  if (process.env.TYPESAFE_API_KEY) {
    return process.env.TYPESAFE_API_KEY.trim();
  }

  // Check native Pi secret store:
  const secretPath = join(homedir(), ".pi/agent/secrets/typesafe_api_key");
  if (existsSync(secretPath)) {
    try {
      const key = readFileSync(secretPath, "utf8").trim();
      if (key) return key;
    } catch {
      // Ignore read errors
    }
  }

  const root = sanitizeFirstmateRoot(firstmateRoot);
  if (!root) return null;

  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, "utf8");
      const match = content.match(/^TYPESAFE_API_KEY=(.*)$/m);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

// Extract full command or descriptive text from an AgentPermissionRequest
export function extractCommand(request: AgentPermissionRequest): string {
  const parts: string[] = [];

  if (request.title) parts.push(request.title);
  if (request.description) parts.push(request.description);

  if (request.detail) {
    const d = request.detail as any;
    if (d.command) parts.push(String(d.command));
    if (d.path) parts.push(String(d.path));
    if (d.description) parts.push(String(d.description));
  }

  if (request.input) {
    const input = request.input as Record<string, unknown>;
    if (typeof input.command === "string") parts.push(input.command);
    if (typeof input.cmd === "string") parts.push(input.cmd);
    if (typeof input.commandLine === "string") parts.push(input.commandLine);
    if (typeof input.command_line === "string") parts.push(input.command_line);
    if (typeof input.shellCommand === "string") parts.push(input.shellCommand);
    if (typeof input.shell_command === "string") parts.push(input.shell_command);
    if (typeof input.path === "string") parts.push(input.path);
    if (typeof input.file === "string") parts.push(input.file);
    if (typeof input.query === "string") parts.push(input.query);
    if (typeof input.pattern === "string") parts.push(input.pattern);
    if (Array.isArray(input.args)) parts.push(input.args.map(String).join(" "));
  }

  return parts.join(" ").trim();
}

/**
 * Fast-path check for obviously safe or obviously dangerous actions.
 * Returns:
 *   true -> definitely safe
 *   false -> definitely dangerous / escalate
 *   null -> ambiguous, requires Jev evaluation
 */
export function fastPathPermissionCheck(
  request: AgentPermissionRequest,
): boolean | null {
  if (hasAnyUnsafeShellSyntax(request)) return false;

  const toolName = (request.name || "").toLowerCase();
  const command = explicitCommand(request);
  const cmd = command ?? extractCommand(request);
  const lowerCmd = cmd.toLowerCase();

  // Shell syntax is never eligible for an automatic approval. Compound or
  // substituted commands must go through Jev or the user confirmation UI.
  if (command !== null && hasUnsafeShellSyntax(command)) {
    return false;
  }

  // Obvious red flags / dangerous patterns -> escalate immediately
  const dangerousPatterns = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|\s+-r)/, // rm -r, rm -rf
    /\brm\s+-[a-zA-Z]*f/, // rm -f
    /\bdelete\b/,
    /\bdrop\s+database\b/,
    /\bdrop\s+table\b/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-[a-zA-Z]*f/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bkill\b/,
    /\bpkill\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bcurl\s+.*\|\s*(bash|sh)\b/,
    /\bwget\s+.*\|\s*(bash|sh)\b/,
    /\.env\b/, // editing/reading env directly via risky actions
    /\bid_rsa\b/,
    /\bcredentials\b/,
    /\btoken\b/,
    /\bsecret\b/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(lowerCmd)) {
      return false; // Escalate to user
    }
  }

  // Obvious safe tool types
  const readOnlyTools = [
    "read",
    "read_file",
    "read_symbol",
    "read_enclosing",
    "cat",
    "ffgrep",
    "fffind",
    "find",
    "grep",
    "symbol_search",
    "project_report",
    "module_report",
    "web_search",
    "source_check",
    "fetch_content",
    "get_search_content",
    "memory_read",
    "memory_search",
    "memory_status",
    "lens_diagnostics",
    "effective_config",
  ];

  if (readOnlyTools.includes(toolName)) {
    // Check if input targets sensitive files or smuggles shell syntax into a
    // command-bearing read tool.
    if (/\.env|id_rsa|credentials|private.key|secret/i.test(cmd)) {
      return false; // Sensitive file read -> escalate
    }
    return true; // Fast-path safe
  }

  if (toolName !== "bash" && toolName !== "shell" && toolName !== "exec") {
    return null;
  }

  // Only an explicit command can be checked against the strict allowlist.
  if (command && isStrictSafeStandaloneCommand(command)) {
    return true;
  }

  // Ambiguous -> let Jev classify
  return null;
}

export async function evaluatePermissionRequest(
  request: AgentPermissionRequest,
  firstmateRoot?: string,
): Promise<PermissionArbiterResult> {
  if (hasAnyUnsafeShellSyntax(request)) {
    return {
      allow: false,
      reason: "Request contains shell metacharacters or command chaining; requires manual review.",
    };
  }

  const fast = fastPathPermissionCheck(request);
  if (fast === true) {
    return {
      allow: true,
      reason: `Fast-path: safe action detected (${request.name})`,
    };
  }
  if (fast === false) {
    return {
      allow: false,
      reason: `Fast-path: potentially dangerous or sensitive action detected (${request.name})`,
    };
  }

  // Ambiguous: query TypeSafe Jev System-1 API
  const apiKey = resolveApiKey(firstmateRoot);
  if (!apiKey) {
    // If no API key, default to safe side (escalate to user)
    return {
      allow: false,
      reason: "No TypeSafe API key available; escalating to user for safety",
    };
  }

  const cmd = extractCommand(request);
  const cacheKey = `${request.name}:${cmd}`;
  const cached = getBoundedCache(permissionCache, cacheKey);
  if (cached) {
    return cached;
  }

  const stateText = scrubSecrets(`Tool: ${request.name}\nKind: ${request.kind}\nDetails: ${cmd}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: stateText,
        questions: {
          permission_safety: {
            type: "choice",
            instructions:
              "Decide whether this tool call is safe to auto-approve for autonomous development or must be escalated to the user for confirmation.",
            criteria: {
              safe_auto_approve:
                "Read-only inspection, searching, running tests, typechecking, building, or routine standard code development action.",
              escalate_to_user:
                "Destructive file deletion, modifying secrets/credentials, git push to remote, external deployment, system configuration changes, or irreversible operations.",
            },
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      const json = (await response.json()) as any;
      const ans = json?.answers?.permission_safety;
      if (ans && ans.choice) {
        const allow = ans.choice === "safe_auto_approve";
        const result: PermissionArbiterResult = {
          allow,
          reason: `Jev System-1 evaluated: ${ans.choice} (confidence: ${(ans.confidence ?? 1).toFixed(2)})`,
        };
        setBoundedCache(permissionCache, cacheKey, result);
        return result;
      }
    }
  } catch {
    // Fall back gracefully
  }

  // Default fail-safe if API call fails or times out: escalate to user
  return {
    allow: false,
    reason: "Jev API unavailable or timed out; escalating to user for confirmation",
  };
}

export async function classifyTaskHealth(
  taskId: string,
  recentLogs: string,
  firstmateRoot?: string,
): Promise<TaskHealthVerdict | null> {
  const apiKey = resolveApiKey(firstmateRoot);
  if (!apiKey || !recentLogs || recentLogs.trim().length === 0) {
    return null;
  }

  const cacheKey = `${taskId}:${stableFingerprint(recentLogs)}`;
  const cached = getBoundedCache(healthCache, cacheKey);
  if (cached) {
    return cached;
  }

  const stateText = scrubSecrets(`Task: ${taskId}\nRecent activity/logs:\n${recentLogs.slice(-2000)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: stateText,
        questions: {
          health: {
            type: "choice",
            instructions:
              "Decide whether the coding agent task is actively progressing, stuck/looping in errors, waiting for user input/decision, or completed.",
            criteria: {
              progressing: "Making active forward progress, editing files, running tests or building.",
              stuck_looping: "Repeating the same failure, caught in a loop, or unable to proceed.",
              waiting_user: "Explicitly waiting for human decision, approval, or input.",
              done: "Task is finished, PR opened, or work completed.",
            },
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    const json = (await response.json()) as any;
    const ans = json?.answers?.health;
    if (ans && ans.choice) {
      const verdict: TaskHealthVerdict = {
        status: ans.choice as any,
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0.85,
      };
      setBoundedCache(healthCache, cacheKey, verdict);
      return verdict;
    }
  } catch {
    // Gracefully handle timeout or network failures
  }

  return null;
}

export async function triagePr(
  prTitle: string,
  prSummary: string,
  firstmateRoot?: string,
  cacheIdentity?: string,
): Promise<PrTriageVerdict | null> {
  const apiKey = resolveApiKey(firstmateRoot);
  if (!apiKey || !prTitle) {
    return null;
  }

  const cacheKey = `${cacheIdentity || prTitle}:${stableFingerprint(`${prTitle}\n${prSummary}`)}`;
  const cached = getBoundedCache(prTriageCache, cacheKey);
  if (cached) {
    return cached;
  }

  const stateText = scrubSecrets(`Pull Request: ${prTitle}\nSummary/Context: ${prSummary}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: stateText,
        questions: {
          triage: {
            type: "choice",
            instructions:
              "Decide whether this pull request is safe for autonomous merging (routine, well-tested, low-risk change) or requires an independent Oracle security/architecture audit (security-sensitive, complex state, architectural risk, or unverified boundaries).",
            criteria: {
              auto_pass:
                "Low-risk, routine feature, documentation, or well-tested straightforward change suitable for auto-merge.",
              oracle_audit:
                "High risk, security-sensitive (crypto, auth, XML/EPUB parsing, path traversal), architecture change, or complex state mutation.",
            },
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    const json = (await response.json()) as any;
    const ans = json?.answers?.triage;
    if (ans && ans.choice) {
      const verdict: PrTriageVerdict = {
        verdict: ans.choice as any,
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0.85,
      };
      setBoundedCache(prTriageCache, cacheKey, verdict);
      return verdict;
    }
  } catch {
    // Gracefully handle timeout or network failures
  }

  return null;
}

/**
 * Smart Dispatch / Model Routing:
 * Matches task prompt against rules in config/crew-dispatch.json using Jev System-1.
 * Ensures:
 * - Never select deepseek/deepseek-v4-flash.
 * - Default to antigravity/gemini-3.8-flash (medium thinking).
 * - Routes unsticking/recovery to cockpit/gpt-5.6-sol (high thinking).
 * - Routes security/architecture to cockpit/gpt-5.6-luna (max thinking).
 * - Routes Burmese script work to antigravity/gemini-3.1-pro (high thinking).
 */
export async function routeModelForPrompt(
  promptText: string,
  firstmateRoot?: string,
): Promise<ModelRoutingResult> {
  const defaultRouting: ModelRoutingResult = {
    model: "antigravity/gemini-3.8-flash",
    thinkingOptionId: "medium",
    reason: "Default high-throughput Flash model",
  };

  if (!promptText || promptText.trim().length === 0) {
    return defaultRouting;
  }

  const apiKey = resolveApiKey(firstmateRoot);
  if (!apiKey) {
    return defaultRouting;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: scrubSecrets(`Task prompt:\n${promptText.slice(0, 1500)}`),
        questions: {
          dispatch: {
            type: "choice",
            instructions:
              "Classify the task category to route to the optimal model based on crew-dispatch rules.",
            criteria: {
              routine_or_standard:
                "Standard feature, UI tweak, routine coding, script, bug fix, or refactoring.",
              security_architecture:
                "Backend security, authentication, session tokens, database drops, core architectural redesigns, concurrency race conditions, or high-stakes pre-merge review.",
              unsticking_recovery:
                "Recovering a stuck worker, diagnosing an intractable error, persistent failure, or debugging when initial attempts have stalled.",
              burmese_voiceover:
                "Burmese voiceover scripts, cultural or spoken translation, SarYayKaung Slim documentary writing, or literary prose.",
            },
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      const json = (await response.json()) as any;
      const choice = json?.answers?.dispatch?.choice;
      if (choice === "security_architecture") {
        return {
          model: "xai/grok-4.7",
          thinkingOptionId: "max",
          reason: "Security / core architecture matched -> Grok 4.7 (max effort)",
        };
      }
      if (choice === "unsticking_recovery") {
        return {
          model: "xai/grok-4.7",
          thinkingOptionId: "high",
          reason: "Intractable error / unsticking matched -> Grok 4.7 (high effort)",
        };
      }
      if (choice === "burmese_voiceover") {
        return {
          model: "antigravity/gemini-3.1-pro",
          thinkingOptionId: "high",
          reason: "Burmese voiceover matched -> Gemini 3.1 Pro (high effort)",
        };
      }
    }
  } catch {
    // Ignore network/timeout errors, return default
  }

  return defaultRouting;
}
