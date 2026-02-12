import { Agent } from "./Agent";
import { DirectorAgent } from "./Director";

export interface SquadConfig {
    id?: string;
    name: string;
    director: DirectorAgent;
    members: Agent[];
    mission?: string;
}

export class Squad {
    public id: string;
    public name: string;
    public director: DirectorAgent;
    public members: Map<string, Agent>; // ID -> Agent
    public mission: string;

    constructor(config: SquadConfig) {
        this.id = config.id || crypto.randomUUID();
        this.name = config.name;
        this.director = config.director;
        this.mission = config.mission || "Collaborate to solve tasks efficiently.";
        this.members = new Map();
        config.members.forEach(m => this.members.set(m.id, m));
    }

    getMemberByName(name: string): Agent | undefined {
        // Case-insensitive search
        for (const agent of this.members.values()) {
            if (agent.name.toLowerCase() === name.toLowerCase()) return agent;
        }
        return undefined;
    }

    getAllAgents(): Agent[] {
        return [this.director, ...Array.from(this.members.values())];
    }
}
