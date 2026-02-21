/**
 * Agent scheduler: manage cron and one-off autonomous runs
 */

import fs from "fs/promises";
import path from "path";

export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  type: "cron" | "once";
  cronExpression?: string; // e.g., "0 9 * * *" (daily at 9 AM)
  runAt?: number; // Unix timestamp for one-off runs
  enabled: boolean;
  maxDurationMs?: number;
  maxRetries?: number;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failureCount: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  agentId: string;
  status: "pending" | "running" | "success" | "failed" | "timeout";
  startedAt?: number;
  completedAt?: number;
  output?: string;
  error?: string;
  durationMs?: number;
}

const SCHEDULES_FILE = path.join(process.cwd(), "data", "schedules.json");
const RUNS_LOG_FILE = path.join(process.cwd(), "data", "schedule-runs.json");

class SchedulerManager {
  private schedules = new Map<string, Schedule>();
  private runs: ScheduleRun[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Ensure data directory exists
      await fs.mkdir(path.dirname(SCHEDULES_FILE), { recursive: true });

      // Load schedules
      try {
        const schedulesContent = await fs.readFile(SCHEDULES_FILE, "utf-8");
        const schedulesList = JSON.parse(schedulesContent) as Schedule[];
        schedulesList.forEach((schedule) => {
          this.schedules.set(schedule.id, schedule);
        });
      } catch {
        // File doesn't exist yet
      }

      // Load runs log
      try {
        const runsContent = await fs.readFile(RUNS_LOG_FILE, "utf-8");
        this.runs = JSON.parse(runsContent) as ScheduleRun[];
      } catch {
        // File doesn't exist yet
      }
    } catch (error) {
      console.error("Failed to initialize SchedulerManager:", error);
    }

    this.isInitialized = true;
    this.startSchedulers();
  }

  /**
   * Create a new schedule
   */
  async createSchedule(schedule: Omit<Schedule, "id" | "createdAt" | "runCount" | "failureCount">): Promise<Schedule> {
    await this.init();

    const id = `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newSchedule: Schedule = {
      ...schedule,
      id,
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
    };

    this.schedules.set(id, newSchedule);
    await this.saveSchedules();

    if (newSchedule.enabled) {
      this.setupScheduleTimer(id);
    }

    return newSchedule;
  }

  /**
   * Get a schedule
   */
  async getSchedule(scheduleId: string): Promise<Schedule | undefined> {
    await this.init();
    return this.schedules.get(scheduleId);
  }

  /**
   * List schedules for an agent
   */
  async listSchedulesForAgent(agentId: string): Promise<Schedule[]> {
    await this.init();
    return Array.from(this.schedules.values()).filter((s) => s.agentId === agentId);
  }

  /**
   * Update a schedule
   */
  async updateSchedule(scheduleId: string, updates: Partial<Schedule>): Promise<Schedule | null> {
    await this.init();

    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;

    const updated = { ...schedule, ...updates, id: scheduleId };
    this.schedules.set(scheduleId, updated);
    await this.saveSchedules();

    // Reset timer if enabled status changed
    if (updates.enabled !== undefined) {
      this.clearScheduleTimer(scheduleId);
      if (updated.enabled) {
        this.setupScheduleTimer(scheduleId);
      }
    }

    return updated;
  }

  /**
   * Delete a schedule
   */
  async deleteSchedule(scheduleId: string): Promise<boolean> {
    await this.init();

    this.clearScheduleTimer(scheduleId);
    const deleted = this.schedules.delete(scheduleId);

    if (deleted) {
      await this.saveSchedules();
    }

    return deleted;
  }

  /**
   * Get runs for a schedule
   */
  async getRunsForSchedule(scheduleId: string, limit: number = 50): Promise<ScheduleRun[]> {
    await this.init();
    return this.runs
      .filter((run) => run.scheduleId === scheduleId)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, limit);
  }

  /**
   * Record a schedule run
   */
  async recordRun(run: Omit<ScheduleRun, "id">): Promise<ScheduleRun> {
    await this.init();

    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newRun: ScheduleRun = { ...run, id };

    this.runs.push(newRun);

    // Update schedule stats
    const schedule = this.schedules.get(run.scheduleId);
    if (schedule) {
      schedule.runCount += 1;
      if (run.status === "failed" || run.status === "timeout") {
        schedule.failureCount += 1;
      }
      schedule.lastRunAt = run.completedAt || Date.now();
      this.schedules.set(run.scheduleId, schedule);
    }

    await this.saveRuns();
    await this.saveSchedules();

    return newRun;
  }

  private startSchedulers(): void {
    for (const [scheduleId, schedule] of this.schedules.entries()) {
      if (schedule.enabled) {
        this.setupScheduleTimer(scheduleId);
      }
    }
  }

  private setupScheduleTimer(scheduleId: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    // For one-off runs, schedule at specified time
    if (schedule.type === "once" && schedule.runAt) {
      const delay = Math.max(0, schedule.runAt - Date.now());
      const timer = setTimeout(() => {
        this.triggerScheduleRun(scheduleId);
      }, delay);
      this.timers.set(scheduleId, timer);
    }

    // For cron, simple interval-based trigger (in production, use proper cron library)
    if (schedule.type === "cron") {
      // Simplified: check every minute if schedule should run
      const timer = setInterval(() => {
        if (this.shouldRunCron(schedule.cronExpression)) {
          this.triggerScheduleRun(scheduleId);
        }
      }, 60000);
      this.timers.set(scheduleId, timer);
    }
  }

  private clearScheduleTimer(scheduleId: string): void {
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.timers.delete(scheduleId);
    }
  }

  private shouldRunCron(cronExpr?: string): boolean {
    if (!cronExpr) return false;

    const now = new Date();
    const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpr.split(" ");

    const matches =
      this.matchesCronPart(minute, now.getMinutes()) &&
      this.matchesCronPart(hour, now.getHours()) &&
      this.matchesCronPart(dayOfMonth, now.getDate()) &&
      this.matchesCronPart(month, now.getMonth() + 1) &&
      this.matchesCronPart(dayOfWeek, now.getDay());

    return matches;
  }

  private matchesCronPart(pattern: string, value: number): boolean {
    if (pattern === "*") return true;
    if (pattern === String(value)) return true;
    if (pattern.includes(",")) {
      return pattern.split(",").some((p) => p === String(value));
    }
    return false;
  }

  private async triggerScheduleRun(scheduleId: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `schedule:${scheduleId}`,
      "schedule.executed",
      { scheduleId, scheduleName: schedule.name }
    );

    // Record the run (will be completed by agent execution)
    await this.recordRun({
      scheduleId,
      agentId: schedule.agentId,
      status: "pending",
      startedAt: Date.now(),
    });
  }

  private async saveSchedules(): Promise<void> {
    try {
      const schedulesList = Array.from(this.schedules.values());
      await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedulesList, null, 2));
    } catch (error) {
      console.error("Failed to save schedules:", error);
    }
  }

  private async saveRuns(): Promise<void> {
    try {
      // Keep only last 1000 runs
      const recentRuns = this.runs.slice(-1000);
      await fs.writeFile(RUNS_LOG_FILE, JSON.stringify(recentRuns, null, 2));
    } catch (error) {
      console.error("Failed to save runs log:", error);
    }
  }
}

export const schedulerManager = new SchedulerManager();
