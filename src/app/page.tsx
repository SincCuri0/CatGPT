"use client";

import { useState, useEffect } from "react";
import { useSettings } from "@/hooks/useSettings";
import { AgentConfig } from "@/lib/core/Agent";
import { Message } from "@/lib/core/types";
import { SettingsModal } from "@/components/SettingsModal";
import { AgentCard } from "@/components/agent/AgentCard";
import { AgentEditor } from "@/components/agent/AgentEditor";
import { ChatInterface } from "@/components/ChatInterface";
import defaultAgents from "@/lib/templates/default_agents.json";
import { Settings, Plus, PawPrint, MessageSquare, PanelLeftClose, MoreHorizontal, Pencil, Trash2, Clock, Cat } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { getAgentPersonality } from "@/lib/agentPersonality";
import {
  Conversation,
  loadConversations,
  upsertConversation,
  deleteConversation as deleteConv,
  renameConversation,
  generateTitle,
} from "@/lib/conversations";

export default function CEODashboard() {
  const { apiKey } = useSettings();
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  // Selection
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentMessages, setCurrentMessages] = useState<Message[]>([]);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHiringOpen, setIsHiringOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfig | undefined>(undefined);

  // Loading State
  const [isProcessing, setIsProcessing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentMenuOpen, setAgentMenuOpen] = useState<string | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Load agents on mount
  useEffect(() => {
    const storedAgents = localStorage.getItem("cat_gpt_agents");
    if (storedAgents) {
      setAgents(JSON.parse(storedAgents));
    } else {
      setAgents(defaultAgents);
    }
  }, []);

  // Load ALL conversations on mount
  useEffect(() => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      const allConvos = loadConversations();
      const conv = allConvos.find(c => c.id === activeConversationId);
      setCurrentMessages(conv?.messages || []);
    } else {
      setCurrentMessages([]);
    }
  }, [activeConversationId]);

  const saveAgents = (newAgents: AgentConfig[]) => {
    setAgents(newAgents);
    localStorage.setItem("cat_gpt_agents", JSON.stringify(newAgents));
  };

  const refreshConversations = () => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setAgentMenuOpen(null);
    setChatMenuOpen(null);
    // Start fresh (no active conversation — shows agent landing page)
    setActiveConversationId(null);
    setCurrentMessages([]);
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setCurrentMessages([]);
  };

  const handleSelectConversation = (convId: string) => {
    const conv = conversations.find(c => c.id === convId);
    if (conv) {
      // Auto-select the linked agent
      setSelectedAgentId(conv.agentId);
    }
    setActiveConversationId(convId);
    setChatMenuOpen(null);
  };

  const handleDeleteConversation = (convId: string) => {
    const conv = conversations.find(c => c.id === convId);
    const confirmed = window.confirm(`Delete "${conv?.title || "this chat"}"? 🗑️`);
    if (confirmed) {
      deleteConv(convId);
      if (activeConversationId === convId) {
        setActiveConversationId(null);
        setCurrentMessages([]);
      }
      refreshConversations();
    }
    setChatMenuOpen(null);
  };

  const handleRenameConversation = (convId: string, newTitle: string) => {
    if (newTitle.trim()) {
      renameConversation(convId, newTitle.trim());
      refreshConversations();
    }
    setRenamingChatId(null);
    setChatMenuOpen(null);
  };

  const handleSendMessage = async (text: string) => {
    if (!selectedAgentId || !apiKey) return;

    const targetAgent = agents.find(a => a.id === selectedAgentId);
    if (!targetAgent) return;

    // Create or use existing conversation
    let convId = activeConversationId;
    let isNew = false;

    if (!convId) {
      // Create new conversation
      convId = uuidv4();
      isNew = true;
    }

    const newUserMsg: Message = {
      id: uuidv4(),
      role: "user",
      content: text,
      timestamp: Date.now()
    };

    const updatedMessages = [...currentMessages, newUserMsg];
    setCurrentMessages(updatedMessages);
    setActiveConversationId(convId);

    // Save conversation immediately (so it appears in history)
    const conv: Conversation = {
      id: convId,
      agentId: selectedAgentId,
      title: isNew ? generateTitle(text) : (conversations.find(c => c.id === convId)?.title || generateTitle(text)),
      messages: updatedMessages,
      createdAt: isNew ? Date.now() : (conversations.find(c => c.id === convId)?.createdAt || Date.now()),
      updatedAt: Date.now(),
    };
    upsertConversation(conv);
    refreshConversations();

    setIsProcessing(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey
        },
        body: JSON.stringify({
          message: text,
          history: updatedMessages,
          agentConfig: targetAgent
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const newAssistantMsg: Message = {
        id: uuidv4(),
        role: "assistant",
        name: targetAgent.name,
        content: data.response,
        timestamp: Date.now()
      };

      const finalMessages = [...updatedMessages, newAssistantMsg];
      setCurrentMessages(finalMessages);

      // Update conversation in storage
      upsertConversation({
        ...conv,
        messages: finalMessages,
        updatedAt: Date.now(),
      });
      refreshConversations();

    } catch (e: any) {
      console.error("Chat Failed", e);
      const errorMsg: Message = {
        id: uuidv4(),
        role: "system",
        content: `Hiss! Something went wrong. ${e.message}`,
        timestamp: Date.now()
      };
      const finalMessages = [...updatedMessages, errorMsg];
      setCurrentMessages(finalMessages);

      upsertConversation({
        ...conv,
        messages: finalMessages,
        updatedAt: Date.now(),
      });
      refreshConversations();
    } finally {
      setIsProcessing(false);
    }
  };

  // Group conversations by time period
  const groupConversations = (convos: Conversation[]) => {
    const now = Date.now();
    const day = 86400000;
    const groups: { label: string; items: Conversation[] }[] = [];

    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const thisWeek: Conversation[] = [];
    const older: Conversation[] = [];

    for (const c of convos) {
      const age = now - c.updatedAt;
      if (age < day) today.push(c);
      else if (age < day * 2) yesterday.push(c);
      else if (age < day * 7) thisWeek.push(c);
      else older.push(c);
    }

    if (today.length > 0) groups.push({ label: "Today", items: today });
    if (yesterday.length > 0) groups.push({ label: "Yesterday", items: yesterday });
    if (thisWeek.length > 0) groups.push({ label: "This Week", items: thisWeek });
    if (older.length > 0) groups.push({ label: "Older", items: older });

    return groups;
  };

  const conversationGroups = groupConversations(conversations);

  return (
    <div className="flex h-screen overflow-hidden bg-[#212121] text-[#ececec] font-sans">

      {/* Sidebar - Collapsible */}
      <div
        className={`${sidebarOpen ? "w-[260px]" : "w-0"} bg-[#171717] flex flex-col transition-all duration-300 ease-in-out overflow-hidden border-r border-white/5 relative z-30`}
      >
        {/* New Chat Button Area */}
        <div className="p-3 pb-0">
          <button
            onClick={handleNewChat}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-white/10 text-sm hover:bg-[#212121] transition-colors text-white text-left shadow-sm group"
          >
            <div className="bg-white text-black rounded-full p-0.5">
              <Plus size={14} strokeWidth={3} />
            </div>
            <span className="font-medium">New chat</span>
            <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
              <MessageSquare size={14} />
            </span>
          </button>
        </div>

        {/* Navigation / Sections */}
        <div className="px-3 py-4 flex flex-col gap-1 flex-1 min-h-0 overflow-hidden">

          {/* Agents Section Header */}
          <div className="text-xs font-semibold text-[#8e8ea0] px-3 py-2 uppercase tracking-wider flex items-center justify-between flex-shrink-0">
            <span className="flex items-center gap-2">
              <PawPrint size={12} className="text-[#10a37f]" />
              Litter
            </span>
            <span className="text-[10px] font-normal text-[#565656]">{agents.length} cats</span>
          </div>

          {/* Agents List */}
          <div className="space-y-1 pr-1 flex-shrink-0 max-h-[40%] overflow-y-auto custom-scrollbar">
            {agents.map(agent => {
              const isSelected = selectedAgentId === agent.id;
              const personality = getAgentPersonality(agent);

              return (
                <div key={agent.id} className="relative">
                  <button
                    onClick={() => handleSelectAgent(agent.id || "")}
                    className={`agent-card w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm group relative overflow-hidden ${isSelected
                      ? "active bg-[#2f2f2f] text-white"
                      : "text-[#ececec] hover:bg-[#212121]"
                      }`}
                    style={{ '--agent-accent': personality.color } as React.CSSProperties}
                  >
                    {/* Cat Avatar */}
                    <div
                      className={`agent-avatar w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-lg relative`}
                      style={{ background: personality.gradient }}
                    >
                      <span className="cat-emoji" role="img" aria-label={personality.label}>
                        {personality.emoji}
                      </span>
                      {/* Online status dot */}
                      {isSelected && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-[#171717] rounded-full flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-[#10a37f] status-dot-purr" />
                        </div>
                      )}
                    </div>

                    {/* Name & Role */}
                    <div className="flex-1 min-w-0 text-left">
                      <div className={`text-[13px] font-medium leading-tight ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                        {agent.name}
                      </div>
                      <div className="text-[11px] text-[#8e8ea0] leading-tight mt-0.5">
                        {agent.role}
                      </div>
                    </div>

                    {/* Hover tools paw prints (shown when menu is closed) */}
                    {agent.tools && agent.tools.length > 0 && agentMenuOpen !== agent.id && (
                      <div className="flex gap-0.5">
                        {agent.tools.slice(0, 3).map((_, i) => (
                          <span key={i} className="tool-paw text-[10px]">🐾</span>
                        ))}
                      </div>
                    )}

                    {/* Three-dot menu button */}
                    <div
                      className={`flex-shrink-0 transition-opacity ${isSelected || agentMenuOpen === agent.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setAgentMenuOpen(agentMenuOpen === agent.id ? null : (agent.id || null));
                        }}
                        className="p-1 rounded hover:bg-[#424242] transition-colors cursor-pointer"
                      >
                        <MoreHorizontal size={14} className="text-[#8e8ea0]" />
                      </div>
                    </div>
                  </button>

                  {/* Dropdown Menu */}
                  {agentMenuOpen === agent.id && (
                    <div className="absolute left-11 top-full mt-1 bg-[#2f2f2f] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150 min-w-[180px]">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingAgent(agent);
                          setIsHiringOpen(true);
                          setAgentMenuOpen(null);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
                      >
                        <Pencil size={12} />
                        <span>Edit Cat</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const confirmed = window.confirm(`Release ${agent.name} back into the wild? 🐈`);
                          if (confirmed) {
                            saveAgents(agents.filter(a => a.id !== agent.id));
                            if (selectedAgentId === agent.id) {
                              setSelectedAgentId(null);
                              setActiveConversationId(null);
                              setCurrentMessages([]);
                            }
                          }
                          setAgentMenuOpen(null);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={12} />
                        <span>Release into the Wild</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              onClick={() => { setEditingAgent(undefined); setIsHiringOpen(true); }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-[#8e8ea0] hover:text-[#10a37f] hover:bg-[#10a37f]/5 transition-all mt-2 border border-dashed border-white/10 hover:border-[#10a37f]/30 group"
            >
              <div className="w-8 h-8 rounded-full border-2 border-dashed border-[#424242] group-hover:border-[#10a37f]/50 flex items-center justify-center transition-colors">
                <Plus size={14} />
              </div>
              <span>Hire New Agent</span>
            </button>
          </div>

          {/* Chat History Section — Always visible */}
          <div className="text-xs font-semibold text-[#8e8ea0] px-3 py-2 mt-3 uppercase tracking-wider flex items-center gap-2 flex-shrink-0">
            <Clock size={12} className="text-[#565656]" />
            Chat History
          </div>

          <div className="flex-1 overflow-y-auto space-y-0.5 pr-1 custom-scrollbar min-h-0">
            {conversationGroups.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-[#565656]">
                No conversations yet.<br />
                Select a cat and start chatting! 🐾
              </div>
            )}

            {conversationGroups.map(group => (
              <div key={group.label}>
                <div className="text-[10px] font-medium text-[#565656] px-3 py-1.5 uppercase tracking-wider">
                  {group.label}
                </div>
                {group.items.map(conv => {
                  const convAgent = agents.find(a => a.id === conv.agentId);
                  const convPersonality = convAgent ? getAgentPersonality(convAgent) : null;

                  return (
                    <div key={conv.id} className="relative group">
                      {renamingChatId === conv.id ? (
                        <div className="px-3 py-1.5">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => handleRenameConversation(conv.id, renameValue)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleRenameConversation(conv.id, renameValue);
                              if (e.key === "Escape") setRenamingChatId(null);
                            }}
                            className="w-full bg-[#2f2f2f] border border-white/20 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#10a37f]"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSelectConversation(conv.id)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-xs transition-colors ${activeConversationId === conv.id
                            ? "bg-[#2f2f2f] text-white"
                            : "text-[#b4b4b4] hover:bg-[#212121] hover:text-[#ececec]"
                            }`}
                        >
                          {/* Agent emoji indicator */}
                          <span className="flex-shrink-0 text-sm" title={convAgent?.name || "Unknown agent"}>
                            {convPersonality?.emoji || "💬"}
                          </span>
                          <span className="flex-1 truncate">{conv.title}</span>

                          {/* Chat menu button */}
                          <div
                            className={`flex-shrink-0 transition-opacity ${activeConversationId === conv.id || chatMenuOpen === conv.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setChatMenuOpen(chatMenuOpen === conv.id ? null : conv.id);
                            }}
                          >
                            <MoreHorizontal size={12} className="text-[#8e8ea0] hover:text-white" />
                          </div>
                        </button>
                      )}

                      {/* Chat Dropdown Menu */}
                      {chatMenuOpen === conv.id && (
                        <div className="absolute right-2 top-full mt-0.5 bg-[#2f2f2f] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150 min-w-[140px]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameValue(conv.title);
                              setRenamingChatId(conv.id);
                              setChatMenuOpen(null);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
                          >
                            <Pencil size={11} />
                            <span>Rename</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConversation(conv.id);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 size={11} />
                            <span>Delete</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* User Profile at Bottom */}
        <div className="mt-auto p-3 border-t border-white/5">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-3 w-full px-3 py-3 rounded-lg hover:bg-[#212121] transition-colors text-sm text-left group"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold border border-white/10">
              HU
            </div>
            <div className="flex-1 truncate font-medium text-[#ececec]">Human User</div>
            <Settings size={16} className="text-[#8e8ea0] group-hover:text-white transition-colors" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full relative bg-[#212121]">

        {/* Toggle Sidebar Button (Mobile/Desktop) */}
        {!sidebarOpen && (
          <div className="absolute top-4 left-4 z-50">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 bg-[#212121] border border-white/10 rounded-md text-[#ececec] hover:bg-[#2f2f2f] shadow-lg"
            >
              <PanelLeftClose size={20} className="rotate-180" />
            </button>
          </div>
        )}
        {sidebarOpen && (
          <div className="absolute top-3 left-2 z-50 md:hidden">
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-2 text-[#8e8ea0] hover:text-white"
            >
              <PanelLeftClose size={20} />
            </button>
          </div>
        )}


        {/* Chat Area */}
        <div className="flex-1 h-full relative">
          {/* API Key Modal Overlay */}
          {!apiKey && (
            <div className="absolute inset-0 z-[60] bg-[#212121]/80 backdrop-blur-sm flex items-center justify-center">
              <div className="bg-[#2f2f2f] border border-white/10 p-8 rounded-2xl shadow-2xl max-w-md w-full text-center">
                <div className="w-16 h-16 bg-[#10a37f]/20 text-[#10a37f] rounded-full flex items-center justify-center mx-auto mb-6">
                  <PawPrint size={32} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">Welcome to CatGPT</h2>
                <p className="text-[#b4b4b4] mb-6 text-sm">
                  Please provide your API Key to initialize the neural pathways.
                </p>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="bg-[#10a37f] hover:bg-[#1a7f64] text-white font-medium px-6 py-3 rounded-lg w-full transition-colors"
                >
                  Connect API Key
                </button>
              </div>
            </div>
          )}

          {selectedAgentId ? (
            <ChatInterface
              agent={agents.find(a => a.id === selectedAgentId)!}
              messages={currentMessages}
              onSendMessage={handleSendMessage}
              isProcessing={isProcessing}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-[#ececec]">
              <div className="mb-8">
                <div className="w-24 h-24 bg-[#2f2f2f] rounded-full flex items-center justify-center mb-6 shadow-2xl skew-y-0 hover:rotate-12 transition-transform duration-500 cursor-cell mx-auto">
                  <Cat size={48} className="text-[#ececec]" />
                </div>
                <h2 className="text-2xl font-semibold mb-2">CatGPT</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl w-full px-6">
                {/* Suggestions */}
                {[
                  "Explain quantum physics to a kitten",
                  "Write a haiku about tuna",
                  "Design a scratching post skyscraper"
                ].map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const randomAgent = agents[0];
                      if (randomAgent) {
                        handleSelectAgent(randomAgent.id || "");
                      }
                    }}
                    className="p-4 bg-[#2f2f2f] hover:bg-[#424242] border border-white/5 rounded-xl text-left text-sm text-[#ececec] transition-colors flex items-center justify-between group"
                  >
                    <span>{suggestion}</span>
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {isHiringOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <AgentEditor
              initialData={editingAgent}
              onSave={(newAgent) => {
                if (editingAgent) {
                  saveAgents(agents.map(a => a.id === newAgent.id ? newAgent : a));
                } else {
                  saveAgents([...agents, { ...newAgent, id: uuidv4() }]);
                }
                setIsHiringOpen(false);
              }}
              onCancel={() => setIsHiringOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
