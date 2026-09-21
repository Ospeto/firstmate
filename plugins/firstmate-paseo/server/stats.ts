export interface JevSystemStats {
  permissionApprovals: number;
  permissionEscalations: number;
  watchdogScans: number;
  watchdogStuckDetected: number;
  modelRoutings: number;
  lastAction: string | null;
}

const stats: JevSystemStats = {
  permissionApprovals: 0,
  permissionEscalations: 0,
  watchdogScans: 0,
  watchdogStuckDetected: 0,
  modelRoutings: 0,
  lastAction: null,
};

export function getJevStats(): JevSystemStats {
  return { ...stats };
}

export function recordPermissionApproval(action: string) {
  stats.permissionApprovals++;
  stats.lastAction = `Auto-approved: ${action.slice(0, 40)}`;
}

export function recordPermissionEscalation(action: string) {
  stats.permissionEscalations++;
  stats.lastAction = `Escalated: ${action.slice(0, 40)}`;
}

export function recordWatchdogScan(status: string) {
  stats.watchdogScans++;
  if (status === "stuck_looping") {
    stats.watchdogStuckDetected++;
  }
  stats.lastAction = `Watchdog: ${status}`;
}

export function recordModelRouting(model: string) {
  stats.modelRoutings++;
  stats.lastAction = `Routed to: ${model}`;
}
