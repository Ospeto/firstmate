import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";
import { FirstmateSurface } from "./client/firstmate";
import { jevTriggerWatchdogRpc } from "./shared/firstmate";

const jevWatchdogWarningSchema = z.object({
  message: z.string(),
  status: z.string(),
  confidence: z.number(),
});

type JevWatchdogData = z.infer<typeof jevWatchdogWarningSchema>;

function JevWatchdogWarningView({ item }: PluginTimelineItemProps<JevWatchdogData>) {
  const data = item.data;
  const confidencePct = Math.round((data?.confidence ?? 1) * 100);

  return (
    <View
      style={{
        marginVertical: 8,
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#451a03",
        borderWidth: 1,
        borderColor: "#f59e0b",
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: "#fbbf24" }}>
          ⚠️ Jev Watchdog Intervention Alert
        </Text>
        <Text style={{ fontSize: 11, fontWeight: "600", color: "#fcd34d" }}>
          {confidencePct}% confidence
        </Text>
      </View>
      <Text style={{ fontSize: 13, color: "#fef3c7", lineHeight: 18 }}>
        {data?.message || "Agent appears stuck or repeating errors. Intervention recommended."}
      </Text>
    </View>
  );
}

function isOperationalInjection(text: string): boolean {
  return (
    text.includes("FIRSTMATE_OP:") ||
    text.includes("\u2063FIRSTMATE_OP:") ||
    text.includes("SESSION START (CONTEXT RE-EMIT)") ||
    (text.includes("SESSION START -") && text.includes("SUPERVISION OPERATING INSTRUCTIONS")) ||
    (text.includes("FLEET STATE") && text.includes("READ-ONCE CONTRACT"))
  );
}

export default function contribute(client: PluginClientContext) {
  // Register full-screen surface and sidebar navigation icon
  client.addSurface("firstmate-fleet", FirstmateSurface);
  client.addSidebarItem({
    id: "firstmate-fleet",
    title: "Firstmate Fleet",
    icon: "Anchor",
    surface: "firstmate-fleet",
  });

  // Register workspace tab panel
  client.addWorkspacePanel({
    id: "firstmate-panel",
    title: "Firstmate Fleet",
    icon: "Anchor",
    context: "workspace",
    Component: FirstmateSurface,
  });

  // Register Command Center (⌘K) actions
  client.addCommandCenterItem({
    id: "open-firstmate-fleet",
    title: "Firstmate: Open Fleet Dashboard",
    icon: "Anchor",
    context: "global",
    onSelect(ctx) {
      ctx.openSurface("firstmate-fleet");
    },
  });

  // Manual Jev Watchdog / Triage trigger on selected agent
  client.addCommandCenterItem({
    id: "firstmate-jev-watchdog-agent",
    title: "Firstmate Jev: Run Watchdog Analysis on Current Agent",
    icon: "Activity",
    context: "agent",
    async onSelect(ctx) {
      try {
        const res = await ctx.rpc(jevTriggerWatchdogRpc, { agentId: ctx.agent.id });
        if (res.success) {
          console.log(`[Jev CC] ${res.message}`);
        } else {
          console.warn(`[Jev CC] ${res.message}`);
        }
      } catch (err) {
        console.error("[Jev CC] Failed to trigger watchdog:", err);
      }
    },
  });

  // Register Jev Watchdog timeline warning renderer
  client.addTimelineRenderer({
    kind: "jev-watchdog-warning",
    version: 1,
    schema: jevWatchdogWarningSchema,
    Component: JevWatchdogWarningView,
  });

  // Hide internal Firstmate operational injections (session-start, compaction context re-emits, turn-end guard, away-supervisor) from Paseo chat timeline
  // Note: Paseo's Pi provider maps custom role messages to assistant_message, while user prompts go to user_message.
  client.addTimelineTransformer({
    id: "firstmate-hide-operational-assistant-injections",
    query: { itemType: "assistant_message" },
    transform: ({ item }) => {
      if (isOperationalInjection(item.text || "")) {
        return { items: [] };
      }
      return undefined;
    },
  });

  client.addTimelineTransformer({
    id: "firstmate-hide-operational-user-injections",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      if (isOperationalInjection(item.text || "")) {
        return { items: [] };
      }
      return undefined;
    },
  });

  return () => {};
}
