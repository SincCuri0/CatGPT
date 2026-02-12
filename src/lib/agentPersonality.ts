import { AgentConfig } from "./core/Agent";

export interface AgentPersonality {
    emoji: string;
    color: string;
    gradient: string;
    label: string;
}

// Maps agent roles/names to unique cat personalities
export function getAgentPersonality(agent: AgentConfig): AgentPersonality {
    const name = agent.name.toLowerCase();
    const role = agent.role.toLowerCase();

    if (name.includes("intern") || name.includes("mittens") || name.includes("kitten")) {
        return {
            emoji: "🐱",
            color: "#f59e0b",
            gradient: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
            label: "Curious Kitten",
        };
    }
    if (name.includes("professor") || name.includes("paws") || role.includes("director")) {
        return {
            emoji: "🎩",
            color: "#8b5cf6",
            gradient: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)",
            label: "Distinguished Professor",
        };
    }
    if (name.includes("keyboard") || role.includes("developer") || role.includes("engineer")) {
        return {
            emoji: "⌨️",
            color: "#06b6d4",
            gradient: "linear-gradient(135deg, #0891b2 0%, #0e7490 100%)",
            label: "Hacker Cat",
        };
    }
    if (name.includes("purr") || role.includes("stray")) {
        return {
            emoji: "😸",
            color: "#10a37f",
            gradient: "linear-gradient(135deg, #10a37f 0%, #059669 100%)",
            label: "Stray Cat",
        };
    }
    if (role.includes("security") || name.includes("shadow")) {
        return {
            emoji: "🐈‍⬛",
            color: "#ef4444",
            gradient: "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)",
            label: "Shadow Cat",
        };
    }
    if (role.includes("design") || role.includes("creative") || name.includes("whiskers")) {
        return {
            emoji: "🎨",
            color: "#ec4899",
            gradient: "linear-gradient(135deg, #db2777 0%, #be185d 100%)",
            label: "Creative Cat",
        };
    }
    if (role.includes("data") || role.includes("analyst")) {
        return {
            emoji: "📊",
            color: "#14b8a6",
            gradient: "linear-gradient(135deg, #0d9488 0%, #0f766e 100%)",
            label: "Data Cat",
        };
    }

    // Fallback — deterministic pick based on agent name
    const fallbackOptions: AgentPersonality[] = [
        { emoji: "😺", color: "#f97316", gradient: "linear-gradient(135deg, #ea580c 0%, #c2410c 100%)", label: "Friendly Cat" },
        { emoji: "😼", color: "#a855f7", gradient: "linear-gradient(135deg, #9333ea 0%, #7e22ce 100%)", label: "Smug Cat" },
        { emoji: "🙀", color: "#ef4444", gradient: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", label: "Dramatic Cat" },
        { emoji: "🐾", color: "#10b981", gradient: "linear-gradient(135deg, #059669 0%, #047857 100%)", label: "Adventurous Cat" },
        { emoji: "😻", color: "#f472b6", gradient: "linear-gradient(135deg, #ec4899 0%, #db2777 100%)", label: "Loving Cat" },
    ];

    const hash = (agent.name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return fallbackOptions[hash % fallbackOptions.length];
}
