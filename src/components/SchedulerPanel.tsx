/**
 * Scheduler Panel - Manage autonomous agent schedules
 */

"use client";

import { useState, useEffect } from "react";
import { useEventSubscription } from "@/hooks/useEventSubscription";
import { Play, Plus, Trash2, Clock, AlertCircle } from "lucide-react";

interface Schedule {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  type: "cron" | "once";
  cronExpression?: string;
  runAt?: number;
  enabled: boolean;
  lastRunAt?: number;
  runCount: number;
  failureCount: number;
}

interface SchedulerPanelProps {
  agentId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function SchedulerPanel({ agentId, isOpen, onClose }: SchedulerPanelProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [newSchedule, setNewSchedule] = useState<{
    name: string;
    type: "cron" | "once";
    cronExpression: string;
    enabled: boolean;
  }>({
    name: "",
    type: "cron",
    cronExpression: "0 9 * * *",
    enabled: true,
  });
  const [isCreating, setIsCreating] = useState(false);

  useEventSubscription({
    channel: [`schedule:${agentId}`, "schedule"], // Listen to specific schedule events or general schedule channel
    onEvent: (event) => {
      if ((event.type === "schedule.created" || event.type === "schedule.executed") &&
        (event.payload.agentId === agentId || (event.payload as any).agentId === agentId)) {
        fetchSchedules();
      }
    },
  });

  useEffect(() => {
    if (isOpen) {
      fetchSchedules();
    }
  }, [isOpen, agentId]);

  const fetchSchedules = async () => {
    try {
      const res = await fetch(`/api/scheduler/schedules?agentId=${agentId}`);
      const data = await res.json();
      setSchedules(data.schedules || []);
    } catch (error) {
      console.error("Failed to fetch schedules:", error);
    }
  };

  const handleCreateSchedule = async () => {
    if (!newSchedule.name.trim()) return;

    setIsCreating(true);
    try {
      const res = await fetch("/api/scheduler/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          ...newSchedule,
        }),
      });

      if (res.ok) {
        setNewSchedule({ name: "", type: "cron", cronExpression: "0 9 * * *", enabled: true });
        fetchSchedules();
      }
    } catch (error) {
      console.error("Failed to create schedule:", error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleSchedule = async (schedule: Schedule) => {
    try {
      await fetch(`/api/scheduler/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      fetchSchedules();
    } catch (error) {
      console.error("Failed to toggle schedule:", error);
    }
  };

  const handleDeleteSchedule = async (scheduleId: string) => {
    if (!confirm("Delete this schedule?")) return;

    try {
      await fetch(`/api/scheduler/schedules/${scheduleId}`, {
        method: "DELETE",
      });
      fetchSchedules();
    } catch (error) {
      console.error("Failed to delete schedule:", error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-[#171717]">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Clock size={20} />
              Schedule Autonomous Runs
            </h2>
            <button
              onClick={onClose}
              className="text-[#8e8ea0] hover:text-white text-2xl"
            >
              ×
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Create New Schedule */}
          <div className="bg-[#2f2f2f] border border-white/10 rounded-lg p-4 space-y-4">
            <h3 className="font-semibold text-white">Create New Schedule</h3>

            <div className="space-y-3">
              <input
                type="text"
                placeholder="Schedule name (e.g., Daily Health Check)"
                value={newSchedule.name}
                onChange={(e) =>
                  setNewSchedule({ ...newSchedule, name: e.target.value })
                }
                className="w-full bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white placeholder-[#565656] focus:outline-none focus:border-[#10a37f]"
              />

              <div className="grid grid-cols-2 gap-3">
                <select
                  value={newSchedule.type}
                  onChange={(e) =>
                    setNewSchedule({
                      ...newSchedule,
                      type: e.target.value as "cron" | "once",
                    })
                  }
                  className="bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#10a37f]"
                >
                  <option value="cron">Recurring (Cron)</option>
                  <option value="once">One-time</option>
                </select>

                {newSchedule.type === "cron" && (
                  <input
                    type="text"
                    placeholder="Cron expression (0 9 * * *)"
                    value={newSchedule.cronExpression}
                    onChange={(e) =>
                      setNewSchedule({
                        ...newSchedule,
                        cronExpression: e.target.value,
                      })
                    }
                    className="bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white placeholder-[#565656] focus:outline-none focus:border-[#10a37f] text-sm"
                  />
                )}
              </div>

              <button
                onClick={handleCreateSchedule}
                disabled={!newSchedule.name.trim() || isCreating}
                className="w-full bg-[#10a37f] hover:bg-[#1a7f64] disabled:bg-[#565656] text-white font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={16} />
                {isCreating ? "Creating..." : "Create Schedule"}
              </button>
            </div>
          </div>

          {/* Schedules List */}
          <div className="space-y-3">
            <h3 className="font-semibold text-white">Your Schedules</h3>

            {schedules.length === 0 ? (
              <div className="text-center py-8 text-[#565656]">
                No schedules created yet
              </div>
            ) : (
              schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="bg-[#2f2f2f] border border-white/10 rounded-lg p-4"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-semibold text-white flex items-center gap-2">
                        {!schedule.enabled && <AlertCircle size={14} className="text-yellow-500" />}
                        {schedule.name}
                      </h4>
                      <p className="text-xs text-[#8e8ea0]">
                        {schedule.type === "cron"
                          ? `Cron: ${schedule.cronExpression}`
                          : `One-time: ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "N/A"}`}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleToggleSchedule(schedule)}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${schedule.enabled
                          ? "bg-[#10a37f]/20 text-[#10a37f] hover:bg-[#10a37f]/30"
                          : "bg-[#565656]/20 text-[#8e8ea0] hover:bg-[#565656]/30"
                          }`}
                      >
                        {schedule.enabled ? "Active" : "Paused"}
                      </button>

                      <button
                        onClick={() => handleDeleteSchedule(schedule.id)}
                        className="p-1.5 text-red-400 hover:bg-red-500/10 rounded"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex gap-4 text-xs text-[#8e8ea0]">
                    <span>Runs: {schedule.runCount}</span>
                    {schedule.failureCount > 0 && (
                      <span className="text-red-400">Failures: {schedule.failureCount}</span>
                    )}
                    {schedule.lastRunAt && (
                      <span>Last: {new Date(schedule.lastRunAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
