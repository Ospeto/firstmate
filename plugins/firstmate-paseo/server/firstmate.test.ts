import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { backlogRpc, dispatchTaskRpc, fleetStatusRpc, taskLogsRpc } from "../shared/firstmate";
import { getBacklog, getFleetStatus, getTaskLogs } from "./firstmate";
import { dispatchTask } from "./dispatch";

describe("fleetStatusRpc", () => {
  it("accepts hideDone boolean in input schema", () => {
    const parsed = fleetStatusRpc.input.parse({ hideDone: true });
    assert.strictEqual(parsed.hideDone, true);

    const parsedFalse = fleetStatusRpc.input.parse({ hideDone: false });
    assert.strictEqual(parsedFalse.hideDone, false);

    const parsedEmpty = fleetStatusRpc.input.parse({});
    assert.strictEqual(parsedEmpty.hideDone, undefined);
  });

  it("filters done tasks when hideDone is true", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);
      writeFileSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), "#!/bin/sh\necho '{}'\n");
      chmodSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), 0o755);

      // Task 1: active
      writeFileSync(join(tempDir, "state", "task-active.meta"), "kind=ship\n");
      writeFileSync(join(tempDir, "state", "task-active.status"), "working: writing code\n");

      // Task 2: done
      writeFileSync(join(tempDir, "state", "task-done.meta"), "kind=ship\n");
      writeFileSync(join(tempDir, "state", "task-done.status"), "done: merged PR\n");

      const allResult = await getFleetStatus({ firstmateRoot: tempDir, hideDone: false });
      assert.strictEqual(allResult.activeTasks.length, 2);
      assert.ok(allResult.activeTasks.some((t) => t.id === "task-active"));
      assert.ok(allResult.activeTasks.some((t) => t.id === "task-done"));

      const filteredResult = await getFleetStatus({ firstmateRoot: tempDir, hideDone: true });
      assert.strictEqual(filteredResult.activeTasks.length, 1);
      assert.strictEqual(filteredResult.activeTasks[0].id, "task-active");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not parse English prose like 'child is' or 'child exit' as child task ids", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-prose-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);
      writeFileSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), "#!/bin/sh\necho '{}'\n");
      chmodSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "secondmates.md"),
        "- mate1 - Test secondmate (host: local; home: " + tempDir + ")\n",
      );

      // Status log with misleading English prose
      writeFileSync(
        join(tempDir, "state", "mate1.status"),
        [
          'blocked: The old child is not running (PID 123 dead)',
          'blocked: Supported lifecycle control cannot confirm child exit: recorded endpoint missing',
          'done [key=child-outcome-real-feature-done-1234]: child real-feature done: PR https://github.com/org/repo/pull/1',
        ].join("\n"),
      );

      const result = await getFleetStatus({ firstmateRoot: tempDir, hideDone: false });
      const ids = result.activeTasks.map((t) => t.id);
      assert.ok(!ids.includes("is"), "must not extract 'is' as task ID");
      assert.ok(!ids.includes("exit"), "must not extract 'exit' as task ID");
      assert.ok(ids.includes("real-feature"), "must extract genuine child task ID");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to data/backlog.md ## Done when bearings snapshot fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-landed-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);
      // bearings snapshot script exits with error (e.g. away mode)
      writeFileSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), "#!/bin/sh\nexit 3\n");
      chmodSync(join(tempDir, "bin", "fm-bearings-snapshot.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "backlog.md"),
        [
          "# Backlog",
          "",
          "## Done",
          "- [x] task-landed-1 - Shipped awesome feature https://github.com/org/repo/pull/42 (repo: my-repo) (kind: ship) (done 2026-09-20)",
        ].join("\n"),
      );

      const result = await getFleetStatus({ firstmateRoot: tempDir });
      assert.strictEqual(result.recentLanded.length, 1);
      assert.strictEqual(result.recentLanded[0].id, "task-landed-1");
      assert.strictEqual(result.recentLanded[0].artifact, "https://github.com/org/repo/pull/42");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("backlogRpc", () => {
  it("validates input schema with optional fields", () => {
    const parsed = backlogRpc.input.parse({});
    assert.strictEqual(parsed.firstmateRoot, undefined);
    assert.strictEqual(parsed.limit, undefined);

    const parsedLimit = backlogRpc.input.parse({ limit: 10 });
    assert.strictEqual(parsedLimit.limit, 10);
  });

  it("rejects limit out of range", () => {
    assert.throws(() => backlogRpc.input.parse({ limit: 0 }));
    assert.throws(() => backlogRpc.input.parse({ limit: 101 }));
  });

  it("returns empty items for repo with no backlog", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-backlog-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      const result = getBacklog({ firstmateRoot: tempDir });
      assert.deepStrictEqual(result, { items: [] });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses queued items from backlog.md fallback", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-backlog-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "backlog.md"),
        [
          "# Backlog",
          "",
          "## In flight",
          "## Queued",
          "- [ ] task-alpha - Implement alpha feature (repo: my-repo) (kind: ship) (since 2026-09-01)",
          "- [ ] task-beta - Fix beta bug (repo: my-repo) (kind: ship) (since 2026-09-02)",
          "## Done",
          "- [x] task-gamma - Done thing (repo: my-repo) (kind: ship) (done 2026-09-01)",
        ].join("\n"),
      );

      const result = getBacklog({ firstmateRoot: tempDir });
      assert.strictEqual(result.items.length, 2);
      assert.strictEqual(result.items[0].id, "task-alpha");
      assert.strictEqual(result.items[0].title, "Implement alpha feature");
      assert.strictEqual(result.items[0].status, "queued");
      assert.strictEqual(result.items[0].repo, "my-repo");
      assert.strictEqual(result.items[1].id, "task-beta");
      assert.strictEqual(result.items[1].title, "Fix beta bug");
      assert.strictEqual(result.items[1].repo, "my-repo");
      assert.strictEqual(result.items[1].id, "task-beta");
      assert.strictEqual(result.items[1].title, "Fix beta bug");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips done items from backlog.md", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-backlog-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "backlog.md"),
        [
          "# Backlog",
          "",
          "## In flight",
          "## Queued",
          "## Done",
          "- [x] task-done - Already completed (repo: my-repo) (kind: ship) (done 2026-09-01)",
        ].join("\n"),
      );

      const result = getBacklog({ firstmateRoot: tempDir });
      assert.strictEqual(result.items.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("respects limit parameter", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-backlog-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "backlog.md"),
        [
          "# Backlog",
          "",
          "## Queued",
          "- [ ] t1 - Task one (repo: r) (kind: ship)",
          "- [ ] t2 - Task two (repo: r) (kind: ship)",
          "- [ ] t3 - Task three (repo: r) (kind: ship)",
        ].join("\n"),
      );

      const result = getBacklog({ firstmateRoot: tempDir, limit: 2 });
      assert.strictEqual(result.items.length, 2);
      assert.strictEqual(result.items[0].id, "t1");
      assert.strictEqual(result.items[1].id, "t2");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses TOON table rows from tasks-axi output with repo, priority, and blocked_by", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-backlog-toon-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));

      writeFileSync(join(tempDir, "AGENTS.md"), "# Test Firstmate");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      const toonOutput = [
        "count: 3",
        "tasks[3]{id,state,kind,repo,title,blocked_by,priority,held,hold_reason}:",
        '  task-1,queued,ship,my-repo,"Build UI component",none,high,no,"-"',
        '  task-2,blocked,ship,other-repo,"Fix database race",task-1,medium,no,"-"',
        '  task-3,done,ship,my-repo,"Old task",none,"-",no,"-"',
        "help[1]:",
        "  - Run tasks-axi show",
      ].join("\n");

      writeFileSync(
        join(tempDir, "bin", "fm-tasks-axi.sh"),
        `#!/bin/sh\ncat <<'EOF'\n${toonOutput}\nEOF\n`,
      );
      chmodSync(join(tempDir, "bin", "fm-tasks-axi.sh"), 0o755);

      const result = getBacklog({ firstmateRoot: tempDir });
      assert.strictEqual(result.items.length, 2);
      assert.strictEqual(result.items[0].id, "task-1");
      assert.strictEqual(result.items[0].repo, "my-repo");
      assert.strictEqual(result.items[0].priority, "high");
      assert.strictEqual(result.items[0].status, "queued");

      assert.strictEqual(result.items[1].id, "task-2");
      assert.strictEqual(result.items[1].repo, "other-repo");
      assert.strictEqual(result.items[1].status, "blocked");
      assert.deepStrictEqual(result.items[1].blockedBy, ["task-1"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("taskLogsRpc", () => {
  it("validates input schema and rejects path traversal", () => {
    assert.doesNotThrow(() =>
      taskLogsRpc.input.parse({ taskId: "t1" }),
    );
    assert.doesNotThrow(() =>
      taskLogsRpc.input.parse({ taskId: "t1", lines: 25 }),
    );
    assert.throws(() =>
      taskLogsRpc.input.parse({ taskId: "" }),
    );
    assert.throws(() =>
      taskLogsRpc.input.parse({ taskId: "../traversal" }),
    );
    assert.throws(() =>
      taskLogsRpc.input.parse({ taskId: "../../etc/passwd" }),
    );
  });

  it("finds status logs in secondmate home when absent in primary", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-logs-sm-test-"));
    const smHome = mkdtempSync(join(tmpdir(), "fm-sm-home-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      mkdirSync(join(tempDir, "data"));
      writeFileSync(join(tempDir, "AGENTS.md"), "# Test");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "secondmates.md"),
        `- sm-worker - Secondmate worker (host: local; home: ${smHome})\n`,
      );

      mkdirSync(join(smHome, "state"));
      writeFileSync(
        join(smHome, "state", "child-task-1.status"),
        ["working: step 1", "working: step 2", "done: all good"].join("\n"),
      );

      const result = await getTaskLogs({ firstmateRoot: tempDir, taskId: "child-task-1", lines: 2 });
      assert.strictEqual(result.taskId, "child-task-1");
      assert.strictEqual(result.totalLines, 3);
      assert.strictEqual(result.lines.length, 2);
      assert.strictEqual(result.lines[1], "done: all good");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(smHome, { recursive: true, force: true });
    }
  });

  it("returns empty lines when task does not exist", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-logs-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      writeFileSync(join(tempDir, "AGENTS.md"), "# Test");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      const result = await getTaskLogs({ firstmateRoot: tempDir, taskId: "nonexistent" });
      assert.strictEqual(result.taskId, "nonexistent");
      assert.deepStrictEqual(result.lines, []);
      assert.strictEqual(result.totalLines, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads and slices tail of task status lines", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-logs-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "state"));
      writeFileSync(join(tempDir, "AGENTS.md"), "# Test");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(join(tempDir, "state", "task1.meta"), "kind=ship\n");
      writeFileSync(
        join(tempDir, "state", "task1.status"),
        [
          "working: starting task",
          "working: running tests",
          "working: tests passed",
          "done: task completed",
        ].join("\n"),
      );

      const result = await getTaskLogs({ firstmateRoot: tempDir, taskId: "task1", lines: 2 });
      assert.strictEqual(result.taskId, "task1");
      assert.strictEqual(result.totalLines, 4);
      assert.strictEqual(result.lines.length, 2);
      assert.strictEqual(result.lines[0], "working: tests passed");
      assert.strictEqual(result.lines[1], "done: task completed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("dispatchTaskRpc", () => {
  it("validates input schema with optional delivery mode, yolo, and backend", () => {
    const valid = dispatchTaskRpc.input.parse({
      project: "p1",
      title: "Task 1",
      mode: "local-only",
      yolo: true,
      backend: "paseo",
    });
    assert.strictEqual(valid.mode, "local-only");
    assert.strictEqual(valid.yolo, true);
    assert.strictEqual(valid.backend, "paseo");

    assert.throws(() =>
      dispatchTaskRpc.input.parse({ project: "", title: "" }),
    );
  });

  it("dispatches to a secondmate via fm-send.sh", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-dispatch-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));
      writeFileSync(join(tempDir, "AGENTS.md"), "# Test");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(join(tempDir, "data", "projects.md"), "- test-proj - A test project\n");
      writeFileSync(join(tempDir, "data", "secondmates.md"), "- test-mate - A test mate\n");

      // Mock fm-send.sh
      writeFileSync(
        join(tempDir, "bin", "fm-send.sh"),
        "#!/bin/sh\necho \"sent to $1: $2\"\n",
      );
      chmodSync(join(tempDir, "bin", "fm-send.sh"), 0o755);

      const result = await dispatchTask({
        firstmateRoot: tempDir,
        project: "test-proj",
        title: "Test Task",
        target: "test-mate",
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes("Dispatched to secondmate test-mate"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("spawns new crewmate with backlog item and brief scaffold", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fm-crew-spawn-test-"));
    try {
      mkdirSync(join(tempDir, ".git"));
      mkdirSync(join(tempDir, "bin"));
      mkdirSync(join(tempDir, "data"));
      mkdirSync(join(tempDir, "projects"));
      mkdirSync(join(tempDir, "projects", "sample-proj"));
      writeFileSync(join(tempDir, "AGENTS.md"), "# Test");
      writeFileSync(join(tempDir, "bin", "fm-session-start.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "bin", "fm-session-start.sh"), 0o755);

      writeFileSync(
        join(tempDir, "data", "projects.md"),
        "- sample-proj [local-only +yolo] - A sample project\n",
      );

      // Mock fm-tasks-axi.sh
      writeFileSync(
        join(tempDir, "bin", "fm-tasks-axi.sh"),
        "#!/bin/sh\necho \"added $2 to backlog\"\n",
      );
      chmodSync(join(tempDir, "bin", "fm-tasks-axi.sh"), 0o755);

      // Mock fm-brief.sh
      writeFileSync(
        join(tempDir, "bin", "fm-brief.sh"),
        '#!/bin/sh\nmkdir -p "data/$1"\necho "scaffold: {TASK} {FIRSTMATE_SPEC} mode=$4" > "data/$1/brief.md"\n',
      );
      chmodSync(join(tempDir, "bin", "fm-brief.sh"), 0o755);

      // Mock fm-spawn.sh
      writeFileSync(
        join(tempDir, "bin", "fm-spawn.sh"),
        '#!/bin/sh\necho "spawned $1 $2 $3 $4 $5 $6 $7 $8"\n',
      );
      chmodSync(join(tempDir, "bin", "fm-spawn.sh"), 0o755);

      const result = await dispatchTask({
        firstmateRoot: tempDir,
        project: "sample-proj",
        title: "Implement widget",
        description: "Widget details",
        backend: "paseo",
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.taskId?.startsWith("qd-"));
      assert.ok(result.message.includes("Spawned new crewmate"));
      assert.ok(result.message.includes("mode: local-only"));
      assert.ok(result.message.includes("yolo: on"));
      assert.ok(result.message.includes("backend: paseo"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
