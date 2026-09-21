import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const DEFAULT_FIRSTMATE_ROOT = "/Users/macbookair/coding_projects/firstmate";

const REQUIRED_FIRSTMATE_FILES = ["AGENTS.md", "bin/fm-session-start.sh"] as const;

function hasValidGitMetadata(root: string): boolean {
  const gitPath = join(root, ".git");
  try {
    const gitStat = lstatSync(gitPath);
    if (gitStat.isDirectory()) return true;
    if (!gitStat.isFile()) return false;

    const content = readFileSync(gitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) return false;
    const gitDir = isAbsolute(match[1]) ? match[1] : join(root, match[1]);
    return statSync(gitDir).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(root: string, relativePath: string): boolean {
  try {
    return lstatSync(join(root, relativePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a caller-supplied root only when it is an actual Firstmate checkout.
 * The marker files are intentionally checked after realpath resolution so an
 * arbitrary directory cannot be used to select scripts for the fleet RPC.
 */
export function sanitizeFirstmateRoot(candidate?: string): string | null {
  const raw = (candidate?.trim() || process.env.FM_ROOT?.trim() || DEFAULT_FIRSTMATE_ROOT).replace(
    /[\\/]+$/,
    "",
  );

  if (!raw || raw.includes("\0") || !isAbsolute(raw)) {
    return null;
  }

  try {
    const rootStat = lstatSync(raw);
    if (!rootStat.isDirectory()) {
      return null;
    }

    const root = realpathSync(raw);
    if (!statSync(root).isDirectory()) {
      return null;
    }

    if (!REQUIRED_FIRSTMATE_FILES.every((file) => isRegularFile(root, file))) {
      return null;
    }

    if (!hasValidGitMetadata(root)) {
      return null;
    }

    return root;
  } catch {
    return null;
  }
}

export function assertFirstmateRoot(candidate?: string): string {
  const root = sanitizeFirstmateRoot(candidate);
  if (!root) {
    throw new Error(
      "Invalid firstmateRoot: expected an authentic Firstmate repository containing AGENTS.md and bin/fm-session-start.sh",
    );
  }
  return root;
}
