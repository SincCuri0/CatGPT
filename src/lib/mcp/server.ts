/**
 * MCP A2A (Agent-to-Agent) Server Manager
 * Handles authenticated message routing and capability enforcement between agents
 */



export interface MCPCapability {
  id: string;
  name: string;
  description: string;
  version: string;
  requiredTools?: string[];
  requiredProviders?: string[];
}

export interface MCPMessage {
  id: string;
  type: "request" | "response" | "broadcast" | "error";
  senderId: string;
  targetId?: string;
  capability?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  timestamp: number;
  metadata?: {
    correlationId?: string;
    sessionId?: string;
    priority?: "low" | "normal" | "high";
  };
}

export interface MCPAgent {
  id: string;
  name: string;
  role: string;
  capabilities: MCPCapability[];
  tools: string[];
  provider?: string;
  model?: string;
}

export interface MCPPolicy {
  agentId: string;
  allowedCapabilities: string[];
  allowedTargets: string[];
  maxRequestsPerMinute?: number;
}

class MCPServer {
  private agents = new Map<string, MCPAgent>();
  private policies = new Map<string, MCPPolicy>();
  private messageQueue: MCPMessage[] = [];
  private requestHandlers = new Map<
    string,
    (msg: MCPMessage) => Promise<MCPMessage>
  >();

  /**
   * Register an agent on the MCP server
   */
  registerAgent(agent: MCPAgent): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): boolean {
    this.agents.delete(agentId);
    this.policies.delete(agentId);
    return true;
  }

  /**
   * Set capability policy for an agent
   */
  setPolicy(policy: MCPPolicy): void {
    this.policies.set(policy.agentId, policy);
  }

  /**
   * Register a request handler for a specific capability
   */
  onCapability(
    capabilityId: string,
    handler: (msg: MCPMessage) => Promise<MCPMessage>,
  ): void {
    this.requestHandlers.set(capabilityId, handler);
  }

  /**
   * Send a message to another agent (with policy checks)
   */
  async sendMessage(message: MCPMessage): Promise<MCPMessage> {
    const sender = this.agents.get(message.senderId);
    if (!sender) {
      return this.errorResponse(message, "AGENT_NOT_FOUND", "Sender agent not found");
    }

    // Check policy
    const policy = this.policies.get(message.senderId);
    if (policy && message.capability) {
      if (!policy.allowedCapabilities.includes(message.capability)) {
        return this.errorResponse(
          message,
          "CAPABILITY_NOT_ALLOWED",
          `Capability ${message.capability} not allowed for agent ${message.senderId}`,
        );
      }

      if (message.targetId && !this.canAccessTarget(policy, message.targetId)) {
        return this.errorResponse(
          message,
          "TARGET_NOT_ALLOWED",
          `Target ${message.targetId} not allowed for agent ${message.senderId}`,
        );
      }
    }

    // Broadcast if no specific target
    if (!message.targetId) {
      this.broadcastMessage(message);
      return { ...message, type: "response", result: { broadcasted: true } };
    }

    // Route to specific agent
    const targetAgent = this.agents.get(message.targetId);
    if (!targetAgent) {
      return this.errorResponse(
        message,
        "TARGET_NOT_FOUND",
        `Target agent ${message.targetId} not found`,
      );
    }

    // Try to find handler
    if (message.capability) {
      const handler = this.requestHandlers.get(message.capability);
      if (handler) {
        try {
          const response = await handler(message);
          return response;
        } catch (error) {
          return this.errorResponse(
            message,
            "HANDLER_ERROR",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
    }

    // Default: create response
    return {
      ...message,
      type: "response",
      result: { acknowledged: true, targetId: message.targetId },
    };
  }

  /**
   * Emit event for realtime sync
   */
  emitMessage(message: MCPMessage): void {
    const { runtimeStateSyncService } = require("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `mcp:${message.senderId}`,
      "mcp.message.sent",
      message as unknown as Record<string, unknown>
    );
  }

  /**
   * Get agent info
   */
  getAgent(agentId: string): MCPAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all registered agents
   */
  getAllAgents(): MCPAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get message queue (for monitoring)
   */
  getMessageQueue(): MCPMessage[] {
    return this.messageQueue;
  }

  private canAccessTarget(policy: MCPPolicy, targetId: string): boolean {
    if (policy.allowedTargets.includes("*")) return true;
    return policy.allowedTargets.includes(targetId);
  }

  private errorResponse(
    message: MCPMessage,
    code: string,
    errorMsg: string,
  ): MCPMessage {
    return {
      ...message,
      type: "error",
      error: { code, message: errorMsg },
    };
  }

  private broadcastMessage(message: MCPMessage): void {
    // Send to all agents except sender
    for (const agent of this.agents.values()) {
      if (agent.id !== message.senderId) {
        this.emitMessage(message);
      }
    }
  }
}

export const mcpServer = new MCPServer();
