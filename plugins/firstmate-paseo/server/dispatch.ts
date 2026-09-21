import type { RpcInput } from "@getpaseo/plugin";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dispatchTaskRpc } from "../shared/firstmate";
import { assertFirstmateRoot } from "./firstmate-root";

function generateTaskId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `qd-${ts}-${suffix}`;
}

function getRegisteredSecondmates(root: string): Set<string> {
  const ids = new Set<string>();
  try {
    const secondmatesFile = resolve(root, "data", "secondmates.md");
    if (!existsSync(secondmatesFile)) return ids;
    const content = readFileSync(secondmatesFile, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^-\s+([a-zA-Z0-9_-]+)\s+-\s+/);
      if (match) ids.add(match[1]);
    }
  } catch {
    // Ignore read errors.
  }
  return ids;
}

function getRegisteredProjects(root: string): Set<string> {
  const names = new Set<string>();
  try {
    const projectsFile = resolve(root, "data", "projects.md");
    if (!existsSync(projectsFile)) return names;
    const content = readFileSync(projectsFile, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^-\s+(\S+)\s+/);
      if (match) names.add(match[1]);
    }
  } catch {
    // Ignore read errors.
  }
  return names;
}

function resolveProjectPosture(root: string, project: string): { mode: "no-mistakes" | "direct-PR" | "local-only"; yolo: "on" | "off" } {
  try {
    const modeScript = resolve(root, "bin/fm-project-mode.sh");
    if (existsSync(modeScript)) {
      const output = execFileSync(modeScript, [project], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, FM_HOME: root, FM_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const parts = output.split(/\s+/);
      const mode = parts[0] as "no-mistakes" | "direct-PR" | "local-only";
      const yolo = parts[1] === "on" ? "on" : "off";
      if (mode === "no-mistakes" || mode === "direct-PR" || mode === "local-only") {
        return { mode, yolo };
      }
    }
  } catch {
    // Fall back to registry parse or default
  }

  // Fallback: parse data/projects.md directly
  try {
    const projectsFile = resolve(root, "data", "projects.md");
    if (existsSync(projectsFile)) {
      const content = readFileSync(projectsFile, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^-\s+(\S+)(?:\s+\[(.*?)\])?/);
        if (match && match[1] === project) {
          const bracket = match[2] || "";
          let mode: "no-mistakes" | "direct-PR" | "local-only" = "no-mistakes";
          let yolo: "on" | "off" = "off";
          if (bracket.includes("direct-PR")) mode = "direct-PR";
          if (bracket.includes("local-only")) mode = "local-only";
          if (bracket.includes("+yolo")) yolo = "on";
          return { mode, yolo };
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return { mode: "direct-PR", yolo: "on" };
}

export async function dispatchTask(input: RpcInput<typeof dispatchTaskRpc>) {
  const root = assertFirstmateRoot(input.firstmateRoot);
  const { project, title, description, target } = input;

  // Validate project exists in registered projects.
  const projects = getRegisteredProjects(root);
  if (!projects.has(project)) {
    return {
      success: false,
      message: `Unknown project "${project}". Registered: ${[...projects].join(", ") || "(none)"}`,
    };
  }

  const secondmates = getRegisteredSecondmates(root);

  // Validate target if provided.
  if (target && target !== "new-crewmate" && !secondmates.has(target)) {
    return {
      success: false,
      message: `Unknown target "${target}". Available secondmates: ${[...secondmates].join(", ") || "(none)"}`,
    };
  }

  const taskId = generateTaskId();

  try {
    if (target && target !== "new-crewmate" && secondmates.has(target)) {
      // Dispatch to an existing secondmate via fm-send.sh.
      const message = description ? `${title}: ${description}` : title;
      const sendScript = resolve(root, "bin/fm-send.sh");
      execFileSync(sendScript, [target, message], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, FM_HOME: root, FM_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      });

      return {
        success: true,
        taskId,
        message: `Dispatched to secondmate ${target}: ${title}`,
      };
    }

    // Resolve project directory
    let projectDir: string;
    if (project === "firstmate") {
      projectDir = root;
    } else {
      projectDir = resolve(root, "projects", project);
      if (!existsSync(projectDir)) {
        // Check if root relative project exists directly
        const directCandidate = resolve(root, project);
        if (existsSync(directCandidate)) {
          projectDir = directCandidate;
        } else {
          return {
            success: false,
            taskId,
            message: `Project directory not found for "${project}" at ${projectDir}`,
          };
        }
      }
    }

    // Resolve delivery mode and yolo
    const posture = resolveProjectPosture(root, project);
    const mode = input.mode || posture.mode;
    let yoloFlag = posture.yolo;
    if (input.yolo !== undefined) {
      yoloFlag = input.yolo ? "on" : "off";
    }

    // Resolve backend
    let backend = input.backend;
    if (!backend) {
      const backendFile = resolve(root, "config", "backend");
      if (existsSync(backendFile)) {
        try {
          const fileBackend = readFileSync(backendFile, "utf8").trim();
          if (fileBackend === "herdr" || fileBackend === "paseo" || fileBackend === "tmux") {
            backend = fileBackend as "herdr" | "paseo" | "tmux";
          }
        } catch {
          // Ignore read error
        }
      }
      backend = backend || "herdr";
    }

    // 1. Add task to backlog first (required by fm-spawn.sh backlog invariant)
    const axiScript = resolve(root, "bin/fm-tasks-axi.sh");
    let addedToBacklog = false;
    if (existsSync(axiScript)) {
      try {
        execFileSync(
          axiScript,
          ["add", taskId, title, "--kind", "ship", "--repo", project],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, FM_HOME: root, FM_ROOT: root },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        addedToBacklog = true;
      } catch {
        // Fall through to markdown fallback
      }
    }

    if (!addedToBacklog) {
      const backlogFile = resolve(root, "data", "backlog.md");
      if (existsSync(backlogFile)) {
        try {
          const content = readFileSync(backlogFile, "utf8");
          const itemLine = `- [ ] ${taskId} - ${title} (repo: ${project}) (kind: ship)`;
          let updatedContent = content;
          if (content.includes("## Queued")) {
            updatedContent = content.replace("## Queued", `## Queued\n${itemLine}`);
          } else {
            updatedContent = `${content.trim()}\n\n## Queued\n${itemLine}\n`;
          }
          writeFileSync(backlogFile, updatedContent, "utf8");
        } catch {
          // Ignore write error
        }
      }
    }

    // 2. Scaffold compliant brief
    const briefDir = resolve(root, "data", taskId);
    mkdirSync(briefDir, { recursive: true });
    const briefPath = resolve(briefDir, "brief.md");

    const briefScript = resolve(root, "bin/fm-brief.sh");
    let scaffoldedBrief = false;
    if (existsSync(briefScript)) {
      try {
        execFileSync(briefScript, [taskId, project, "--mode", mode], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, FM_HOME: root, FM_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (existsSync(briefPath)) {
          let briefContent = readFileSync(briefPath, "utf8");
          briefContent = briefContent.replace(
            "{TASK}",
            `${title}\n\n${description || title}`,
          );
          briefContent = briefContent.replace(
            "{FIRSTMATE_SPEC}",
            `Implement the requested changes for ${project}, test thoroughly, and verify all automated checks pass.`,
          );
          writeFileSync(briefPath, briefContent, "utf8");
          scaffoldedBrief = true;
        }
      } catch {
        // Fall through to manual brief creation
      }
    }

    if (!scaffoldedBrief) {
      const briefContent = [
        `# Task`,
        "",
        `## Captain's intent`,
        title,
        "",
        description || title,
        "",
        `## Firstmate spec`,
        `Implement the requested changes for ${project}, test thoroughly, and verify all automated checks pass.`,
        "",
        `# Definition of done`,
        `Delivery contract: mode=${mode}`,
        "",
      ].join("\n");
      writeFileSync(briefPath, briefContent, "utf8");
    }

    // 3. Spawn crewmate via fm-spawn.sh
    const spawnScript = resolve(root, "bin/fm-spawn.sh");
    execFileSync(
      spawnScript,
      [taskId, projectDir, "--mode", mode, "--yolo", yoloFlag, "--backend", backend],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, FM_HOME: root, FM_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return {
      success: true,
      taskId,
      message: `Spawned new crewmate for "${title}" (task: ${taskId}, mode: ${mode}, yolo: ${yoloFlag}, backend: ${backend})`,
    };
  } catch (err: any) {
    return {
      success: false,
      taskId,
      message: `Dispatch failed: ${err?.message || String(err)}`,
    };
  }
}
