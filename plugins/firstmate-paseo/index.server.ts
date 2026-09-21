import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dispatchTask } from "./server/dispatch";
import { getFleetStatus, getTaskLogs, getBacklog } from "./server/firstmate";
import {
  evaluatePermissionRequest,
  classifyTaskHealth,
  routeModelForPrompt,
  extractCommand,
} from "./server/jev";
import {
  recordPermissionApproval,
  recordPermissionEscalation,
  recordWatchdogScan,
  recordModelRouting,
} from "./server/stats";
import { backlogRpc, dispatchTaskRpc, fleetStatusRpc, taskLogsRpc, jevTriggerWatchdogRpc } from "./shared/firstmate";

export default function contribute(server: PluginServerContext) {
  // 1. RPC Handlers
  server.handle(fleetStatusRpc, getFleetStatus);
  server.handle(taskLogsRpc, getTaskLogs);
  server.handle(backlogRpc, getBacklog);
  server.handle(dispatchTaskRpc, dispatchTask);

  server.handle(jevTriggerWatchdogRpc, async (input, { paseo }) => {
    try {
      const agentRef = paseo.agents.ref(input.agentId);
      const timelineResult = await agentRef.timeline.refetch();
      const messages = (timelineResult.entries || [])
        .map((e: any) => e.item)
        .filter(
          (item: any) =>
            item && (item.type === "user_message" || item.type === "assistant_message"),
        )
        .map((item: any) => `${item.type}: ${item.text || ""}`)
        .join("\n\n");

      const verdict = await classifyTaskHealth(
        input.agentId,
        messages || "No recent activity recorded",
      );

      if (verdict) {
        recordWatchdogScan(verdict.status);
        if (verdict.status === "stuck_looping") {
          await agentRef.timeline.append({
            type: "plugin",
            id: `jev-watchdog-${Date.now()}`,
            kind: "jev-watchdog-warning",
            version: 1,
            data: {
              message:
                "⚠️ [Jev Watchdog] Agent appears stuck or repeating errors. Intervention recommended.",
              status: verdict.status,
              confidence: verdict.confidence,
            },
          });
        }
        return {
          success: true,
          message: `Watchdog check completed: ${verdict.status} (${(verdict.confidence * 100).toFixed(0)}% confidence)`,
          verdict,
        };
      }

      return {
        success: false,
        message: "Jev could not determine trajectory (API unreachable or no logs).",
        verdict: null,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Watchdog error: ${err?.message || err}`,
        verdict: null,
      };
    }
  });

  // 2. Autonomous Permission Arbiter
  server.on("agent.permission_requested", async (event, { paseo }) => {
    const { agent, request } = event;
    const cmd = extractCommand(request) || request.name;
    console.log(
      `[Jev Permission] Permission requested for agent=${agent.id} tool=${request.name} cmd="${cmd.slice(0, 80)}"`,
    );

    try {
      const result = await evaluatePermissionRequest(request);
      if (result.allow) {
        console.log(
          `[Jev Permission] Auto-approving safe action for agent=${agent.id}: ${result.reason}`,
        );
        recordPermissionApproval(cmd);
        await paseo.agents.ref(agent.id).respondToPermission({
          requestId: request.id,
          response: { behavior: "allow" },
        });
      } else {
        console.log(
          `[Jev Permission] Escalating action to user for agent=${agent.id}: ${result.reason}`,
        );
        recordPermissionEscalation(cmd);
        // Do nothing, allowing Paseo UI to display permission modal
      }
    } catch (err) {
      console.error(`[Jev Permission] Error evaluating permission request:`, err);
    }
  });

  // 3. Loop & Stagnation Watchdog (agent.turn_ended)
  server.on("agent.turn_ended", async (event, { paseo }) => {
    const { agent, timeline, outcome } = event;
    try {
      // Build recent conversation snippet
      const recentSnippet = (timeline || [])
        .slice(-20)
        .map((item: any) => {
          if (item.text) return `${item.type}: ${item.text}`;
          if (item.content) return `${item.type}: ${item.content}`;
          return `${item.type}`;
        })
        .join("\n");

      if (!recentSnippet || recentSnippet.trim().length === 0) return;

      const verdict = await classifyTaskHealth(agent.id, recentSnippet);
      if (verdict) {
        recordWatchdogScan(verdict.status);
        if (verdict.status === "stuck_looping") {
          console.warn(
            `[Jev Watchdog] Agent ${agent.id} classified as stuck_looping (confidence: ${verdict.confidence}). Warning user timeline.`,
          );
          await paseo.agents.ref(agent.id).timeline.append({
            type: "plugin",
            id: `jev-watchdog-${Date.now()}`,
            kind: "jev-watchdog-warning",
            version: 1,
            data: {
              message:
                "⚠️ [Jev Watchdog] Detected repetitive error cycle or stalled trajectory. Consider checking agent instructions or intervening.",
              status: verdict.status,
              confidence: verdict.confidence,
            },
          });
        }
      }
    } catch (err) {
      console.error(`[Jev Watchdog] Error running turn_ended watchdog:`, err);
    }
  });

  // 4. Smart Dispatch & Model Routing (agent.create)
  server.before("agent.create", async (input) => {
    try {
      const config = input.request.config;
      // If model is unspecified or default, route via Jev
      if (!config.model || config.model === "default") {
        const promptText =
          (input.request as any).prompt ||
          config.systemPrompt ||
          config.title ||
          "";

        const routing = await routeModelForPrompt(promptText);
        console.log(
          `[Jev Dispatch] Routed agent prompt to model=${routing.model} thinking=${routing.thinkingOptionId || "default"} (${routing.reason})`,
        );
        recordModelRouting(routing.model);

        config.model = routing.model;
        if (routing.thinkingOptionId) {
          config.thinkingOptionId = routing.thinkingOptionId;
        }
      } else {
        // Enforce safety rule: never allow deepseek/deepseek-v4-flash unless explicit
        if (config.model.includes("deepseek-v4-flash")) {
          console.warn(
            `[Jev Dispatch] Blocked unauthorized deepseek-v4-flash; substituting antigravity/gemini-3.8-flash`,
          );
          config.model = "antigravity/gemini-3.8-flash";
          config.thinkingOptionId = "medium";
        }
      }

      return input.request;
    } catch (err) {
      console.error(`[Jev Dispatch] Error during agent.create routing:`, err);
      return input.request;
    }
  });

  return () => {};
}
