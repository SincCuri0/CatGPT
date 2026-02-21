/**
 * MCP Agent Manager - Register and manage agent capabilities
 */

"use client";

import { useState, useEffect } from "react";
import { useEventSubscription } from "@/hooks/useEventSubscription";

import { Network, Plus, Trash2, Shield, AlertCircle, Copy, Check } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  role?: string;
  capabilities: string[];
}

interface MCPPolicy {
  agentId: string;
  allowedCapabilities: string[];
  allowedTargets: string[];
  maxRequestsPerMinute?: number;
  requiresApproval?: boolean;
}

interface MCPAgentManagerProps {
  isOpen: boolean;
  onClose: () => void;
  currentAgentId?: string;
}

export function MCPAgentManager({
  isOpen,
  onClose,
  currentAgentId,
}: MCPAgentManagerProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [policies, setPolicies] = useState<Record<string, MCPPolicy>>({});
  const [newAgent, setNewAgent] = useState({
    name: "",
    role: "worker",
    capabilities: "tool-calling,context-retrieval",
  });
  const [isRegistering, setIsRegistering] = useState(false);
  const [copiedAgentId, setCopiedAgentId] = useState<string | null>(null);

  useEventSubscription({
    channel: "mcp", // Subscribe to general MCP channel
    onEvent: (event) => {
      // We might need to check payload for type if the event structure is different
      if (event.type === "mcp.agent.registered" || event.type === "mcp.agent.unregistered") {
        fetchAgents();
      }
    },
  });

  useEffect(() => {
    if (isOpen) {
      fetchAgents();
    }
  }, [isOpen]);

  const fetchAgents = async () => {
    try {
      const res = await fetch("/api/mcp");
      const data = await res.json();
      setAgents(data.agents || []);

      // Fetch policies for each agent
      const policiesMap: Record<string, MCPPolicy> = {};
      for (const agent of data.agents || []) {
        try {
          const policyRes = await fetch(`/api/mcp?agentId=${agent.id}`);
          const policyData = await policyRes.json();
          if (policyData.policy) {
            policiesMap[agent.id] = policyData.policy;
          }
        } catch { }
      }
      setPolicies(policiesMap);
    } catch (error) {
      console.error("Failed to fetch agents:", error);
    }
  };

  const handleRegisterAgent = async () => {
    if (!newAgent.name.trim()) return;

    setIsRegistering(true);
    try {
      const capabilities = newAgent.capabilities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      // For now, we'll simulate agent registration via a message
      // In a real implementation, this would call an agent registration endpoint
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register",
          agent: {
            name: newAgent.name,
            role: newAgent.role,
            capabilities,
          },
        }),
      });

      if (res.ok) {
        setNewAgent({
          name: "",
          role: "worker",
          capabilities: "tool-calling,context-retrieval",
        });
        fetchAgents();
      }
    } catch (error) {
      console.error("Failed to register agent:", error);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleUnregisterAgent = async (agentId: string) => {
    if (!confirm("Unregister this agent?")) return;

    try {
      // Simulated unregister via message
      await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unregister",
          agentId,
        }),
      });

      fetchAgents();
    } catch (error) {
      console.error("Failed to unregister agent:", error);
    }
  };

  const handleCopyAgentId = (agentId: string) => {
    navigator.clipboard.writeText(agentId);
    setCopiedAgentId(agentId);
    setTimeout(() => setCopiedAgentId(null), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-[#171717]">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Network size={20} />
              Agent Network (MCP/A2A)
            </h2>
            <button
              onClick={onClose}
              className="text-[#8e8ea0] hover:text-white text-2xl"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-[#8e8ea0] mt-1">
            Register agents and configure message routing policies
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Register New Agent */}
          <div className="bg-[#2f2f2f] border border-white/10 rounded-lg p-4 space-y-4">
            <h3 className="font-semibold text-white">Register New Agent</h3>

            <div className="space-y-3">
              <input
                type="text"
                placeholder="Agent name"
                value={newAgent.name}
                onChange={(e) =>
                  setNewAgent({ ...newAgent, name: e.target.value })
                }
                className="w-full bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white placeholder-[#565656] focus:outline-none focus:border-[#10a37f]"
              />

              <select
                value={newAgent.role}
                onChange={(e) =>
                  setNewAgent({ ...newAgent, role: e.target.value })
                }
                className="w-full bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#10a37f]"
              >
                <option value="coordinator">Coordinator (orchestrator)</option>
                <option value="worker">Worker (task executor)</option>
                <option value="analyst">Analyst (data processor)</option>
                <option value="monitor">Monitor (observer)</option>
              </select>

              <textarea
                placeholder="Capabilities (comma-separated, e.g., tool-calling,context-retrieval,code-execution)"
                value={newAgent.capabilities}
                onChange={(e) =>
                  setNewAgent({ ...newAgent, capabilities: e.target.value })
                }
                className="w-full bg-[#1f1f1f] border border-white/10 rounded-lg px-3 py-2 text-white placeholder-[#565656] focus:outline-none focus:border-[#10a37f] resize-none h-20 text-sm"
              />

              <button
                onClick={handleRegisterAgent}
                disabled={!newAgent.name.trim() || isRegistering}
                className="w-full bg-[#10a37f] hover:bg-[#1a7f64] disabled:bg-[#565656] text-white font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={16} />
                {isRegistering ? "Registering..." : "Register Agent"}
              </button>
            </div>
          </div>

          {/* Connected Agents */}
          <div className="space-y-3">
            <h3 className="font-semibold text-white">Registered Agents ({agents.length})</h3>

            {agents.length === 0 ? (
              <div className="text-center py-8 text-[#565656]">
                No agents registered yet
              </div>
            ) : (
              agents.map((agent) => {
                const policy = policies[agent.id];
                const isCurrent = agent.id === currentAgentId;

                return (
                  <div
                    key={agent.id}
                    className={`border rounded-lg p-4 ${isCurrent
                      ? "bg-[#10a37f]/10 border-[#10a37f]/50"
                      : "bg-[#2f2f2f] border-white/10"
                      }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <h4 className="font-semibold text-white flex items-center gap-2">
                          {agent.name}
                          {isCurrent && (
                            <span className="text-xs px-2 py-1 bg-[#10a37f]/20 text-[#10a37f] rounded">
                              Current
                            </span>
                          )}
                        </h4>
                        <p className="text-xs text-[#8e8ea0] font-mono mt-1">
                          ID: {agent.id.substring(0, 8)}...
                        </p>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleCopyAgentId(agent.id)}
                          className="p-2 text-[#8e8ea0] hover:bg-white/10 rounded"
                          title="Copy agent ID"
                        >
                          {copiedAgentId === agent.id ? (
                            <Check size={14} className="text-green-500" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>

                        <button
                          onClick={() => handleUnregisterAgent(agent.id)}
                          className="p-2 text-red-400 hover:bg-red-500/10 rounded"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Agent Details */}
                    <div className="space-y-2 text-xs">
                      {agent.role && (
                        <div>
                          <span className="text-[#8e8ea0]">Role:</span>
                          <span className="ml-2 text-white capitalize">{agent.role}</span>
                        </div>
                      )}

                      {agent.capabilities.length > 0 && (
                        <div>
                          <span className="text-[#8e8ea0]">Capabilities:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {agent.capabilities.map((cap) => (
                              <span
                                key={cap}
                                className="bg-[#10a37f]/20 text-[#10a37f] px-2 py-1 rounded"
                              >
                                {cap}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {policy && (
                        <div>
                          <span className="text-[#8e8ea0] flex items-center gap-1">
                            <Shield size={12} />
                            Policy Restrictions:
                          </span>
                          {policy.requiresApproval && (
                            <div className="text-yellow-500 mt-1">
                              ⚠️ Requires approval for messages
                            </div>
                          )}
                          {policy.maxRequestsPerMinute && (
                            <div className="text-[#8e8ea0] mt-1">
                              Rate limit: {policy.maxRequestsPerMinute}/min
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Info Box */}
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <p className="text-xs text-blue-300 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                Agents communicate via message passing. Configure policies to control what capabilities each agent can
                invoke and which agents they can target.
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
