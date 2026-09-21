import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { backlogRpc, dispatchTaskRpc, fleetStatusRpc, taskLogsRpc } from "../shared/firstmate";
import { openExternal } from "./web";

const LOG_MONO_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function getLogLineColor(
  line: string,
  theme: PluginSurfaceProps["theme"],
): string {
  const trimmed = line.trimStart().toLowerCase();
  if (trimmed.startsWith("done") || trimmed.startsWith("resolved")) return "#34d399";
  if (trimmed.startsWith("blocked") || trimmed.startsWith("needs-decision")) return "#f87171";
  if (trimmed.startsWith("paused")) return "#fbbf24";
  return theme.colors.foregroundMuted;
}

function TaskLogsPanel({
  taskId,
  theme,
}: {
  taskId: string;
  theme: PluginSurfaceProps["theme"];
}) {
  const [expanded, setExpanded] = useState(false);
  const getTaskLogs = useRpc(taskLogsRpc);

  const logsQuery = useQuery({
    queryKey: ["firstmate", "taskLogs", taskId],
    queryFn: () => getTaskLogs({ taskId, lines: 15 }),
    enabled: expanded,
    refetchInterval: expanded ? 5000 : false,
    refetchOnWindowFocus: expanded,
  });

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const panelStyles = useMemo(
    () => ({
      toggleRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        marginTop: 6,
      },
      toggleButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      toggleText: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.accent,
      },
      lineCount: {
        fontSize: 11,
        color: theme.colors.foregroundMuted,
      },
      logContainer: {
        marginTop: 8,
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 10,
        maxHeight: 200,
      },
      logLine: {
        fontSize: 12,
        lineHeight: 18,
        fontFamily: LOG_MONO_FONT,
      },
      refreshRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        marginBottom: 6,
      },
      miniRefresh: {
        paddingVertical: 2,
        paddingHorizontal: 6,
        borderRadius: 4,
        backgroundColor: theme.colors.surface1,
      },
      miniRefreshText: {
        fontSize: 10,
        fontWeight: "600" as const,
        color: theme.colors.accent,
      },
    }),
    [theme],
  );

  return (
    <View>
      <View style={panelStyles.toggleRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide logs" : "View logs"}
          style={panelStyles.toggleButton}
          onPress={toggle}
        >
          <Text style={panelStyles.toggleText}>
            {expanded ? "▾ Hide Logs" : "▸ View Logs"}
          </Text>
        </Pressable>
        {logsQuery.data ? (
          <Text style={panelStyles.lineCount}>
            {logsQuery.data.totalLines} total lines
          </Text>
        ) : null}
      </View>

      {expanded ? (
        <View style={panelStyles.logContainer}>
          <View style={panelStyles.refreshRow}>
            <Text style={panelStyles.lineCount}>📋 Worker Logs</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh logs"
              style={panelStyles.miniRefresh}
              onPress={() => logsQuery.refetch()}
            >
              <Text style={panelStyles.miniRefreshText}>
                {logsQuery.isFetching ? "..." : "Refresh"}
              </Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ maxHeight: 160 }}
            nestedScrollEnabled
          >
            {logsQuery.data && logsQuery.data.lines.length > 0 ? (
              logsQuery.data.lines.map((line, i) => (
                <Text
                  key={`${taskId}-log-${i}`}
                  style={[
                    panelStyles.logLine,
                    { color: getLogLineColor(line, theme) },
                  ]}
                  numberOfLines={1}
                >
                  {line}
                </Text>
              ))
            ) : (
              <Text
                style={[
                  panelStyles.logLine,
                  { color: theme.colors.foregroundMuted, fontStyle: "italic" },
                ]}
              >
                {logsQuery.isLoading ? "Loading..." : "No log entries yet."}
              </Text>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function QuickDispatchPanel({
  theme,
  secondmates,
  projects,
  prefill,
  onClearPrefill,
}: {
  theme: PluginSurfaceProps["theme"];
  secondmates: Array<{ id: string; scope: string }> | undefined;
  projects: Array<{ name: string; posture?: string }> | undefined;
  prefill?: { title: string; project?: string; description?: string } | null;
  onClearPrefill?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState<string>("new-crewmate");
  const [backend, setBackend] = useState<"herdr" | "paseo" | "tmux">("herdr");
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const queryClient = useQueryClient();
  const callDispatch = useRpc(dispatchTaskRpc);

  useEffect(() => {
    if (prefill) {
      setTitle(prefill.title);
      if (prefill.description) setDescription(prefill.description);
      if (prefill.project) setSelectedProject(prefill.project);
      setExpanded(true);
      onClearPrefill?.();
    }
  }, [prefill, onClearPrefill]);

  const mutation = useMutation({
    mutationFn: (input: {
      project: string;
      title: string;
      description?: string;
      target?: string;
      backend?: "herdr" | "paseo" | "tmux";
    }) => callDispatch(input),
    onSuccess: (result) => {
      if (result.success) {
        setFeedback({ type: "success", message: result.message });
        setTitle("");
        setDescription("");
        // Auto-refresh fleet status after dispatch.
        queryClient.invalidateQueries({ queryKey: ["firstmate", "fleetStatus"] });
      } else {
        setFeedback({ type: "error", message: result.message });
      }
      setTimeout(() => setFeedback(null), 6000);
    },
    onError: (err: any) => {
      setFeedback({ type: "error", message: `Dispatch error: ${err?.message || String(err)}` });
      setTimeout(() => setFeedback(null), 6000);
    },
  });

  const handleDispatch = useCallback(() => {
    const proj = selectedProject || projects?.[0]?.name;
    if (!proj) {
      setFeedback({ type: "error", message: "No project available to dispatch to." });
      setTimeout(() => setFeedback(null), 4000);
      return;
    }
    if (!title.trim()) {
      setFeedback({ type: "error", message: "Task title is required." });
      setTimeout(() => setFeedback(null), 4000);
      return;
    }
    mutation.mutate({
      project: proj,
      title: title.trim(),
      description: description.trim() || undefined,
      target: target || undefined,
      backend: target === "new-crewmate" ? backend : undefined,
    });
  }, [selectedProject, projects, title, description, target, backend, mutation]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const targetOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: "new-crewmate", label: "🚀 New Crewmate" },
    ];
    if (secondmates) {
      for (const sm of secondmates) {
        opts.push({ value: sm.id, label: `📡 ${sm.id}` });
      }
    }
    return opts;
  }, [secondmates]);

  const panelStyles = useMemo(
    () => ({
      wrapper: {
        gap: 10,
      },
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      headerTitle: {
        fontSize: 15,
        fontWeight: "700" as const,
        color: theme.colors.foreground,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
      },
      expandButton: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      expandText: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.accent,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: 14,
        gap: 12,
      },
      label: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
        marginBottom: 4,
      },
      input: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.surface2,
      },
      inputFocused: {
        borderColor: theme.colors.accent,
      },
      multilineInput: {
        minHeight: 60,
        textAlignVertical: "top" as const,
      },
      targetRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      targetPill: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.surface2,
      },
      targetPillActive: {
        borderColor: theme.colors.accent,
        backgroundColor: "#1e3a8a",
      },
      targetPillText: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
      },
      targetPillTextActive: {
        color: "#60a5fa",
      },
      projectRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      dispatchButton: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      dispatchButtonDisabled: {
        opacity: 0.5,
      },
      dispatchButtonText: {
        fontSize: 14,
        fontWeight: "700" as const,
        color: "#ffffff",
      },
      feedbackSuccess: {
        backgroundColor: "#064e3b",
        borderRadius: 8,
        padding: 10,
      },
      feedbackError: {
        backgroundColor: "#7f1d1d",
        borderRadius: 8,
        padding: 10,
      },
      feedbackText: {
        fontSize: 13,
        fontWeight: "600" as const,
      },
      feedbackSuccessText: {
        color: "#34d399",
      },
      feedbackErrorText: {
        color: "#f87171",
      },
    }),
    [theme],
  );

  return (
    <View style={panelStyles.wrapper}>
      <View style={panelStyles.headerRow}>
        <Text style={panelStyles.headerTitle}>⚡ Quick Dispatch</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse dispatch panel" : "Expand dispatch panel"}
          style={panelStyles.expandButton}
          onPress={toggle}
        >
          <Text style={panelStyles.expandText}>
            {expanded ? "▾ Collapse" : "▸ Expand"}
          </Text>
        </Pressable>
      </View>

      {expanded ? (
        <View style={panelStyles.card}>
          {/* Project picker */}
          {projects && projects.length > 1 ? (
            <View>
              <Text style={panelStyles.label}>PROJECT</Text>
              <View style={panelStyles.projectRow}>
                {projects.map((proj) => {
                  const isActive = (selectedProject || projects[0]?.name) === proj.name;
                  return (
                    <Pressable
                      key={proj.name}
                      accessibilityRole="button"
                      accessibilityLabel={`Select project ${proj.name}`}
                      style={[panelStyles.targetPill, isActive ? panelStyles.targetPillActive : undefined]}
                      onPress={() => setSelectedProject(proj.name)}
                    >
                      <Text
                        style={[
                          panelStyles.targetPillText,
                          isActive ? panelStyles.targetPillTextActive : undefined,
                        ]}
                      >
                        {proj.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Task title */}
          <View>
            <Text style={panelStyles.label}>TASK TITLE</Text>
            <TextInput
              accessibilityLabel="Task title"
              style={panelStyles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="What needs doing?"
              placeholderTextColor={theme.colors.foregroundMuted}
              returnKeyType="next"
              editable={!mutation.isPending}
            />
          </View>

          {/* Description */}
          <View>
            <Text style={panelStyles.label}>DESCRIPTION (OPTIONAL)</Text>
            <TextInput
              accessibilityLabel="Task description"
              style={[panelStyles.input, panelStyles.multilineInput]}
              value={description}
              onChangeText={setDescription}
              placeholder="Additional context..."
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              numberOfLines={3}
              editable={!mutation.isPending}
            />
          </View>

          {/* Target picker */}
          <View>
            <Text style={panelStyles.label}>DISPATCH TO</Text>
            <View style={panelStyles.targetRow}>
              {targetOptions.map((opt) => {
                const isActive = target === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    accessibilityRole="button"
                    accessibilityLabel={`Dispatch to ${opt.label}`}
                    style={[panelStyles.targetPill, isActive ? panelStyles.targetPillActive : undefined]}
                    onPress={() => setTarget(opt.value)}
                  >
                    <Text
                      style={[
                        panelStyles.targetPillText,
                        isActive ? panelStyles.targetPillTextActive : undefined,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Backend picker for new crewmate */}
          {target === "new-crewmate" ? (
            <View>
              <Text style={panelStyles.label}>RUNTIME BACKEND</Text>
              <View style={panelStyles.targetRow}>
                {[
                  { value: "herdr", label: "Herdr" },
                  { value: "paseo", label: "Paseo (Tabs)" },
                  { value: "tmux", label: "Tmux" },
                ].map((b) => {
                  const isActive = backend === b.value;
                  return (
                    <Pressable
                      key={b.value}
                      accessibilityRole="button"
                      accessibilityLabel={`Backend ${b.label}`}
                      style={[panelStyles.targetPill, isActive ? panelStyles.targetPillActive : undefined]}
                      onPress={() => setBackend(b.value as any)}
                    >
                      <Text
                        style={[
                          panelStyles.targetPillText,
                          isActive ? panelStyles.targetPillTextActive : undefined,
                        ]}
                      >
                        {b.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Dispatch button */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dispatch task"
            style={[
              panelStyles.dispatchButton,
              (mutation.isPending || !title.trim()) ? panelStyles.dispatchButtonDisabled : undefined,
            ]}
            onPress={handleDispatch}
            disabled={mutation.isPending || !title.trim()}
          >
            <Text style={panelStyles.dispatchButtonText}>
              {mutation.isPending ? "Dispatching..." : "🚀 Dispatch"}
            </Text>
          </Pressable>

          {/* Feedback */}
          {feedback ? (
            <View style={feedback.type === "success" ? panelStyles.feedbackSuccess : panelStyles.feedbackError}>
              <Text
                style={[
                  panelStyles.feedbackText,
                  feedback.type === "success" ? panelStyles.feedbackSuccessText : panelStyles.feedbackErrorText,
                ]}
              >
                {feedback.type === "success" ? "✓ " : "✗ "}{feedback.message}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function FirstmateSurface({ theme, layout }: PluginSurfaceProps) {
  const [hideDone, setHideDone] = useState(true);
  const [backlogExpanded, setBacklogExpanded] = useState<boolean | null>(null);
  const [dispatchPrefill, setDispatchPrefill] = useState<{
    title: string;
    project?: string;
    description?: string;
  } | null>(null);
  const getFleetStatus = useRpc(fleetStatusRpc);
  const getBacklog = useRpc(backlogRpc);
  const query = useQuery({
    queryKey: ["firstmate", "fleetStatus", hideDone],
    queryFn: () => getFleetStatus({ hideDone }),
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const data = query.data;

  const backlogQuery = useQuery({
    queryKey: ["firstmate", "backlog"],
    queryFn: () => getBacklog({}),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const backlogItems = useMemo(() => backlogQuery.data?.items ?? [], [backlogQuery.data?.items]);
  // Default expanded if items > 0, collapsed if empty (only auto-set once)
  const isBacklogExpanded = backlogExpanded ?? backlogItems.length > 0;

  const allTasks = useMemo(() => data?.activeTasks ?? [], [data?.activeTasks]);
  const isDoneTask = (task: (typeof allTasks)[number]) =>
    task.status === "done" || task.health?.status === "done";

  const doneCount = useMemo(
    () => allTasks.filter(isDoneTask).length,
    [allTasks],
  );

  const displayedTasks = useMemo(() => {
    if (!hideDone) return allTasks;
    return allTasks.filter((task) => !isDoneTask(task));
  }, [allTasks, hideDone]);

  const styles = useMemo(
    () => ({
      container: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 20,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.surface1,
        paddingBottom: 16,
      },
      title: {
        fontSize: 22,
        fontWeight: "700" as const,
        color: theme.colors.foreground,
      },
      subtitle: {
        fontSize: 13,
        color: theme.colors.foregroundMuted,
        marginTop: 4,
      },
      refreshButton: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      refreshText: {
        fontSize: 13,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
      },
      section: {
        gap: 10,
      },
      sectionHeaderRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      togglePill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.surface2,
      },
      togglePillActive: {
        borderColor: theme.colors.accent,
      },
      togglePillText: {
        fontSize: 11,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
      },
      togglePillTextActive: {
        color: theme.colors.accent,
      },
      sectionTitle: {
        fontSize: 15,
        fontWeight: "700" as const,
        color: theme.colors.foreground,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: 14,
        gap: 8,
      },
      cardAlert: {
        borderWidth: 1,
        borderColor: "#ef4444",
      },
      cardHeader: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
      },
      cardTitle: {
        fontSize: 15,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
        flex: 1,
      },
      badgeRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      badge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: {
        fontSize: 11,
        fontWeight: "700" as const,
        color: theme.colors.foregroundMuted,
        textTransform: "uppercase" as const,
      },
      badgeSuccess: {
        backgroundColor: "#064e3b",
      },
      badgeSuccessText: {
        color: "#34d399",
      },
      badgeWarning: {
        backgroundColor: "#78350f",
      },
      badgeWarningText: {
        color: "#fbbf24",
      },
      badgeDanger: {
        backgroundColor: "#7f1d1d",
      },
      badgeDangerText: {
        color: "#f87171",
      },
      badgeInfo: {
        backgroundColor: "#1e3a8a",
      },
      badgeInfoText: {
        color: "#60a5fa",
      },
      cardBody: {
        fontSize: 13,
        color: theme.colors.foregroundMuted,
        lineHeight: 18,
      },
      actionRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        marginTop: 4,
      },
      linkButton: {
        alignSelf: "flex-start" as const,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      linkText: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.accent,
      },
      triagePill: {
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
      },
      triageText: {
        fontSize: 11,
        fontWeight: "700" as const,
      },
      emptyState: {
        padding: 16,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
      },
      emptyText: {
        fontSize: 13,
        color: theme.colors.foregroundMuted,
        fontStyle: "italic" as const,
      },
      statusRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        marginTop: 4,
      },
      statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
      },
      statsGrid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 12,
        marginTop: 4,
      },
      statBox: {
        flex: 1,
        minWidth: 100,
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 10,
        alignItems: "center" as const,
      },
      statNumber: {
        fontSize: 18,
        fontWeight: "700" as const,
        color: theme.colors.foreground,
      },
      statLabel: {
        fontSize: 11,
        color: theme.colors.foregroundMuted,
        marginTop: 2,
        textAlign: "center" as const,
      },
      footerNote: {
        paddingVertical: 8,
        alignItems: "center" as const,
      },
      footerText: {
        fontSize: 11,
        color: theme.colors.foregroundMuted,
      },
      sectionHeaderPressable: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        flex: 1,
      },
      collapseChevron: {
        fontSize: 13,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
        marginRight: 8,
      },
      dispatchButton: {
        alignSelf: "flex-start" as const,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: "#1e3a8a",
      },
      dispatchText: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: "#60a5fa",
      },
      blockedByText: {
        fontSize: 12,
        color: "#f87171",
        marginTop: 2,
      },
      heldReasonText: {
        fontSize: 12,
        color: "#fbbf24",
        fontStyle: "italic" as const,
        marginTop: 2,
      },
    }),
    [theme, layout.compact],
  );

  const isHelm = data?.isHelm ?? false;
  const lockHolder = data?.lockHolder;
  const jevStats = data?.jevStats;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>⚓ Firstmate Fleet</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isHelm ? "#10b981" : lockHolder ? "#f59e0b" : "#6b7280" },
              ]}
            />
            <Text style={styles.subtitle}>
              {isHelm
                ? `Helm Active (Session PID: ${lockHolder})`
                : lockHolder
                  ? `Managed by Helm (Session PID: ${lockHolder})`
                  : "No Session Lock"}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh fleet status"
          style={styles.refreshButton}
          onPress={() => query.refetch()}
        >
          <Text style={styles.refreshText}>{query.isFetching ? "Refreshing..." : "Refresh"}</Text>
        </Pressable>
      </View>

      {/* Quick Dispatch Panel */}
      <QuickDispatchPanel
        theme={theme}
        secondmates={data?.secondmates}
        projects={data?.projects}
        prefill={dispatchPrefill}
        onClearPrefill={() => setDispatchPrefill(null)}
      />

      {/* Jev System-1 Automation Panel */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Jev System-1 Automation</Text>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>⚡ Autonomous Subagent Supervisor</Text>
            <View style={[styles.badge, styles.badgeSuccess]}>
              <Text style={[styles.badgeText, styles.badgeSuccessText]}>Active</Text>
            </View>
          </View>
          <Text style={styles.cardBody}>
            Jev Permission Arbiter: Active (Auto-approving safe tool calls)
          </Text>

          <View style={styles.statsGrid}>
            <View style={statBoxStyle(styles.statBox)}>
              <Text style={styles.statNumber}>{jevStats?.permissionApprovals ?? 0}</Text>
              <Text style={styles.statLabel}>Auto-Approvals</Text>
            </View>
            <View style={statBoxStyle(styles.statBox)}>
              <Text style={styles.statNumber}>{jevStats?.permissionEscalations ?? 0}</Text>
              <Text style={styles.statLabel}>Escalations</Text>
            </View>
            <View style={statBoxStyle(styles.statBox)}>
              <Text style={styles.statNumber}>{jevStats?.watchdogScans ?? 0}</Text>
              <Text style={styles.statLabel}>Watchdog Scans</Text>
            </View>
            <View style={statBoxStyle(styles.statBox)}>
              <Text style={styles.statNumber}>{jevStats?.modelRoutings ?? 0}</Text>
              <Text style={styles.statLabel}>Model Routings</Text>
            </View>
          </View>

          {jevStats?.lastAction ? (
            <View style={{ marginTop: 6 }}>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                Latest: {jevStats.lastAction}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Autonomous Secondmates */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Autonomous Secondmates</Text>
        {data?.secondmates && data.secondmates.length > 0 ? (
          data.secondmates.map((sm) => (
            <View key={sm.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{sm.id}</Text>
                <View style={styles.badgeRow}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{sm.host ?? "local"}</Text>
                  </View>
                  <View
                    style={[
                      styles.badge,
                      sm.state === "active_child_work" || sm.state === "alive" ? styles.badgeSuccess : undefined,
                    ]}
                  >
                    <Text
                      style={[
                        styles.badgeText,
                        sm.state === "active_child_work" || sm.state === "alive"
                          ? styles.badgeSuccessText
                          : undefined,
                      ]}
                    >
                      {sm.state}
                    </Text>
                  </View>
                </View>
              </View>
              <Text style={styles.cardBody}>{sm.scope}</Text>
            </View>
          ))
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No registered secondmates.</Text>
          </View>
        )}
      </View>

      {/* Active Crew Tasks with Jev Classification */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>
            Active Crew Tasks ({displayedTasks.length})
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hideDone ? `Show Done (${doneCount})` : "Hide Done"}
            style={[styles.togglePill, !hideDone ? styles.togglePillActive : undefined]}
            onPress={() => setHideDone((prev) => !prev)}
          >
            <Text
              style={[
                styles.togglePillText,
                !hideDone ? styles.togglePillTextActive : undefined,
              ]}
            >
              {hideDone ? `Show Done (${doneCount})` : "Hide Done"}
            </Text>
          </Pressable>
        </View>

        {displayedTasks && displayedTasks.length > 0 ? (
          displayedTasks.map((task) => {
            const isStuck = task.health?.status === "stuck_looping";
            const isWaiting = task.health?.status === "waiting_user";
            const isProgressing = task.health?.status === "progressing";

            return (
              <View key={task.id} style={[styles.card, isStuck ? styles.cardAlert : undefined]}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{task.name}</Text>
                  <View style={styles.badgeRow}>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{task.kind}</Text>
                    </View>
                    {task.secondmate ? (
                      <View style={[styles.badge, styles.badgeInfo]}>
                        <Text style={[styles.badgeText, styles.badgeInfoText]}>[{task.secondmate}]</Text>
                      </View>
                    ) : null}

                    {/* Jev Health Badge */}
                    {task.health ? (
                      <View
                        style={[
                          styles.badge,
                          isStuck
                            ? styles.badgeDanger
                            : isWaiting
                              ? styles.badgeWarning
                              : isProgressing
                                ? styles.badgeSuccess
                                : styles.badgeInfo,
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeText,
                            isStuck
                              ? styles.badgeDangerText
                              : isWaiting
                                ? styles.badgeWarningText
                                : isProgressing
                                  ? styles.badgeSuccessText
                                  : styles.badgeInfoText,
                          ]}
                        >
                          {isStuck
                            ? "⚠ Stuck"
                            : isWaiting
                              ? "⏸ Waiting"
                              : isProgressing
                                ? "▶ Active"
                                : "✓ Done"}
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{task.status}</Text>
                      </View>
                    )}
                  </View>
                </View>

                {task.doing ? <Text style={styles.cardBody}>{task.doing}</Text> : null}

                {/* PR and Jev Triage Row */}
                {task.prUrl ? (
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={`Open PR for ${task.name}`}
                      style={styles.linkButton}
                      onPress={() => openExternal(task.prUrl!)}
                    >
                      <Text style={styles.linkText}>View PR ↗</Text>
                    </Pressable>

                    {/* Jev Pre-PR Triage Pill */}
                    {task.prTriage ? (
                      <View
                        style={[
                          styles.triagePill,
                          task.prTriage.verdict === "auto_pass" ? styles.badgeSuccess : styles.badgeWarning,
                        ]}
                      >
                        <Text
                          style={[
                            styles.triageText,
                            task.prTriage.verdict === "auto_pass"
                              ? styles.badgeSuccessText
                              : styles.badgeWarningText,
                          ]}
                        >
                          {task.prTriage.verdict === "auto_pass"
                            ? `✓ Jev Auto-Pass (${Math.round(task.prTriage.confidence * 100)}%)`
                            : `⚠ Jev Oracle Audit (${Math.round(task.prTriage.confidence * 100)}%)`}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {/* Worker Logs Panel */}
                <TaskLogsPanel taskId={task.id} theme={theme} />
              </View>
            );
          })
        ) : allTasks.length > 0 && hideDone ? (
          <View style={styles.emptyState}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show completed tasks"
              onPress={() => setHideDone(false)}
            >
              <Text style={styles.emptyText}>
                {"No active crew tasks (" + doneCount + " completed hidden)."}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show completed tasks"
              style={[styles.linkButton, { marginTop: 8 }]}
              onPress={() => setHideDone(false)}
            >
              <Text style={styles.linkText}>Show completed tasks ↗</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>Nothing currently underway.</Text>
          </View>
        )}
      </View>

      {/* 📋 Backlog Queue */}
      <View style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isBacklogExpanded ? "Collapse backlog queue" : "Expand backlog queue"}
          style={styles.sectionHeaderRow}
          onPress={() => setBacklogExpanded(!isBacklogExpanded)}
        >
          <Text style={styles.sectionTitle}>
            📋 Backlog Queue{backlogItems.length > 0 ? ` (${backlogItems.length})` : ""}
          </Text>
          <Text style={styles.collapseChevron}>
            {isBacklogExpanded ? "▾" : "▸"}
          </Text>
        </Pressable>

        {isBacklogExpanded ? (
          backlogItems.length > 0 ? (
            backlogItems.map((item) => {
              const isQueued = item.status === "queued";
              const isBlocked = item.status === "blocked";
              const isHeld = item.status === "held";

              return (
                <View key={item.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{item.title}</Text>
                    <View style={styles.badgeRow}>
                      {item.repo ? (
                        <View style={[styles.badge, styles.badgeInfo]}>
                          <Text style={[styles.badgeText, styles.badgeInfoText]}>{item.repo}</Text>
                        </View>
                      ) : null}
                      {item.priority ? (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>{item.priority}</Text>
                        </View>
                      ) : null}
                      <View
                        style={[
                          styles.badge,
                          isQueued
                            ? styles.badgeInfo
                            : isBlocked
                              ? styles.badgeDanger
                              : isHeld
                                ? styles.badgeWarning
                                : undefined,
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeText,
                            isQueued
                              ? styles.badgeInfoText
                              : isBlocked
                                ? styles.badgeDangerText
                                : isHeld
                                  ? styles.badgeWarningText
                                  : undefined,
                          ]}
                        >
                          {item.status}
                        </Text>
                      </View>
                    </View>
                  </View>

                  {isBlocked && item.blockedBy && item.blockedBy.length > 0 ? (
                    <Text style={styles.blockedByText}>
                      Blocked by: {item.blockedBy.join(", ")}
                    </Text>
                  ) : null}

                  {isHeld && item.heldReason ? (
                    <Text style={styles.heldReasonText}>
                      {item.heldReason}
                    </Text>
                  ) : null}

                  {item.note ? <Text style={styles.cardBody}>{item.note}</Text> : null}

                  {isQueued ? (
                    <View style={styles.actionRow}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Dispatch ${item.title}`}
                        style={styles.dispatchButton}
                        onPress={() => {
                          setDispatchPrefill({
                            title: item.title,
                            project: item.repo,
                            description: item.note,
                          });
                        }}
                      >
                        <Text style={styles.dispatchText}>▶ Dispatch</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No queued, blocked, or held tasks.</Text>
            </View>
          )
        ) : null}
      </View>

      {/* Fleet Projects */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Fleet Projects</Text>
        {data?.projects && data.projects.length > 0 ? (
          data.projects.map((proj) => (
            <View key={proj.name} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{proj.name}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{proj.posture}</Text>
                </View>
              </View>
              <Text style={styles.cardBody}>{proj.description}</Text>
            </View>
          ))
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No registered projects.</Text>
          </View>
        )}
      </View>

      {/* Recently Landed Work */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recently Landed Work</Text>
        {data?.recentLanded && data.recentLanded.length > 0 ? (
          data.recentLanded.map((item) => (
            <View key={item.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{item.what}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.owner}</Text>
                </View>
              </View>
              {item.artifact && item.artifact.startsWith("http") ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open artifact for ${item.what}`}
                  style={styles.linkButton}
                  onPress={() => openExternal(item.artifact)}
                >
                  <Text style={styles.linkText}>View Merged PR ↗</Text>
                </Pressable>
              ) : (
                <Text style={styles.cardBody}>{item.artifact}</Text>
              )}
            </View>
          ))
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No recent completions.</Text>
          </View>
        )}
      </View>

      {/* Jev Telemetry Footer */}
      <View style={styles.footerNote}>
        <Text style={styles.footerText}>⚡ Powered by TypeSafe Jev System-1 Triage (~150ms)</Text>
      </View>
    </ScrollView>
  );
}

function statBoxStyle(base: any) {
  return base;
}
