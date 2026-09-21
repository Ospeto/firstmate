import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const firstmateRootSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/])/.test(value) && !value.includes("\0"),
    "firstmateRoot must be an absolute path",
  )
  .transform((value) => value.replace(/[\\/]+$/, "") || value);

export const fleetProjectSchema = z.object({
  name: z.string(),
  posture: z.string(),
  description: z.string(),
});

export const fleetSecondmateSchema = z.object({
  id: z.string(),
  state: z.string(),
  host: z.string().nullable(),
  scope: z.string(),
  home: z.string().nullable().optional(),
});

export const fleetTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  prUrl: z.string().nullable(),
  doing: z.string().nullable(),
  secondmate: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  health: z
    .object({
      status: z.enum(["progressing", "stuck_looping", "waiting_user", "done"]),
      confidence: z.number(),
    })
    .nullable(),
  prTriage: z
    .object({
      verdict: z.enum(["auto_pass", "oracle_audit"]),
      confidence: z.number(),
    })
    .nullable(),
});

export const fleetLandedSchema = z.object({
  id: z.string(),
  what: z.string(),
  artifact: z.string(),
  owner: z.string(),
});

export const jevStatsSchema = z.object({
  permissionApprovals: z.number(),
  permissionEscalations: z.number(),
  watchdogScans: z.number(),
  watchdogStuckDetected: z.number(),
  modelRoutings: z.number(),
  lastAction: z.string().nullable(),
});

export const fleetStatusRpc = defineRpc({
  name: "firstmate.fleet-status",
  input: z.object({
    firstmateRoot: firstmateRootSchema.optional(),
    hideDone: z.boolean().optional(),
  }),
  output: z.object({
    home: z.string(),
    lockHolder: z.string().nullable(),
    isHelm: z.boolean(),
    generatedAt: z.string(),
    projects: z.array(fleetProjectSchema),
    secondmates: z.array(fleetSecondmateSchema),
    activeTasks: z.array(fleetTaskSchema),
    recentLanded: z.array(fleetLandedSchema),
    jevStats: jevStatsSchema.optional(),
  }),
});

export const taskLogsRpc = defineRpc({
  name: "firstmate.task-logs",
  input: z.object({
    firstmateRoot: firstmateRootSchema.optional(),
    taskId: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "taskId must contain only letters, numbers, hyphens, and underscores"),
    lines: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    taskId: z.string(),
    lines: z.array(z.string()),
    totalLines: z.number(),
  }),
});

export const dispatchTaskRpc = defineRpc({
  name: "firstmate.dispatch-task",
  input: z.object({
    firstmateRoot: firstmateRootSchema.optional(),
    project: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    target: z.string().optional(),
    mode: z.enum(["no-mistakes", "direct-PR", "local-only"]).optional(),
    yolo: z.boolean().optional(),
    backend: z.enum(["herdr", "paseo", "tmux"]).optional(),
  }),
  output: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    message: z.string(),
  }),
});

export const backlogItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  repo: z.string().optional(),
  priority: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  note: z.string().optional(),
  heldReason: z.string().optional(),
});

export const backlogRpc = defineRpc({
  name: "firstmate.backlog",
  input: z.object({
    firstmateRoot: firstmateRootSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({
    items: z.array(backlogItemSchema),
  }),
});

export const jevTriggerWatchdogRpc = defineRpc({
  name: "firstmate.jev-trigger-watchdog",
  input: z.object({
    agentId: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
    message: z.string(),
    verdict: z
      .object({
        status: z.string(),
        confidence: z.number(),
      })
      .nullable(),
  }),
});
