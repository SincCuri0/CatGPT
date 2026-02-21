/**
 * Skills management: import, validate, and attach SKILL.md to agents
 */

import fs from "fs/promises";
import path from "path";

export interface SkillMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  tools?: string[];
  requiredProviders?: string[];
  instructions?: string;
  examples?: string[];
}

export interface Skill {
  id: string;
  metadata: SkillMetadata;
  content: string; // Full skill.md content
  createdAt: number;
  importedBy?: string;
  tags?: string[];
}

const SKILLS_DIR = path.join(process.cwd(), "data", "skills");
const SKILLS_INDEX_FILE = path.join(SKILLS_DIR, "index.json");

class SkillsManager {
  private skills = new Map<string, Skill>();
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Ensure skills directory exists
      await fs.mkdir(SKILLS_DIR, { recursive: true });

      // Load index
      try {
        const indexContent = await fs.readFile(SKILLS_INDEX_FILE, "utf-8");
        const skillsList = JSON.parse(indexContent) as Skill[];
        skillsList.forEach((skill) => {
          this.skills.set(skill.id, skill);
        });
      } catch {
        // Index doesn't exist yet
      }
    } catch (error) {
      console.error("Failed to initialize SkillsManager:", error);
    }

    this.isInitialized = true;
  }

  /**
   * Import a skill from markdown content
   */
  async importSkill(markdown: string, importedBy?: string): Promise<Skill> {
    await this.init();

    const metadata = this.parseSkillMarkdown(markdown);
    const skillId = `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const skill: Skill = {
      id: skillId,
      metadata: { ...metadata, id: skillId },
      content: markdown,
      createdAt: Date.now(),
      importedBy,
      tags: this.extractTags(metadata.description),
    };

    this.skills.set(skillId, skill);
    await this.saveIndex();

    return skill;
  }

  /**
   * Get a skill by ID
   */
  async getSkill(skillId: string): Promise<Skill | undefined> {
    await this.init();
    return this.skills.get(skillId);
  }

  /**
   * List all skills
   */
  async listSkills(): Promise<Skill[]> {
    await this.init();
    return Array.from(this.skills.values());
  }

  /**
   * Search skills by name or tag
   */
  async searchSkills(query: string): Promise<Skill[]> {
    await this.init();
    const q = query.toLowerCase();
    return Array.from(this.skills.values()).filter((skill) => {
      const nameMatch = skill.metadata.name.toLowerCase().includes(q);
      const descMatch = skill.metadata.description.toLowerCase().includes(q);
      const tagMatch = skill.tags?.some((tag) => tag.toLowerCase().includes(q));
      return nameMatch || descMatch || tagMatch;
    });
  }

  /**
   * Delete a skill
   */
  async deleteSkill(skillId: string): Promise<boolean> {
    await this.init();
    const deleted = this.skills.delete(skillId);
    if (deleted) {
      await this.saveIndex();
    }
    return deleted;
  }

  /**
   * Get skills for an agent (based on tool requirements)
   */
  async getAvailableSkillsForAgent(agentTools: string[]): Promise<Skill[]> {
    await this.init();
    const toolSet = new Set(agentTools);

    return Array.from(this.skills.values()).filter((skill) => {
      const requiredTools = skill.metadata.tools || [];
      return requiredTools.every((tool) => toolSet.has(tool));
    });
  }

  private parseSkillMarkdown(markdown: string): SkillMetadata {
    const lines = markdown.split("\n");
    const metadata: Partial<SkillMetadata> = {
      name: "Untitled Skill",
      version: "1.0.0",
      description: "",
    };

    let inFrontmatter = false;
    let frontmatterEnd = 0;

    // Parse YAML frontmatter or markdown headers
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() === "---") {
        inFrontmatter = !inFrontmatter;
        if (!inFrontmatter) {
          frontmatterEnd = i;
          break;
        }
        continue;
      }

      if (inFrontmatter && line.includes(":")) {
        const [key, value] = line.split(":").map((s) => s.trim());
        if (key === "name") metadata.name = value;
        if (key === "version") metadata.version = value;
        if (key === "description") metadata.description = value;
        if (key === "author") metadata.author = value;
        if (key === "tools")
          metadata.tools = value.split(",").map((t) => t.trim());
        if (key === "requiredProviders")
          metadata.requiredProviders = value.split(",").map((p) => p.trim());
      }

      // Parse markdown headers as fallback
      if (!inFrontmatter) {
        if (line.startsWith("# ")) {
          metadata.name = line.slice(2).trim();
        }
        if (line.startsWith("## ")) {
          const header = line.slice(3).trim().toLowerCase();
          if (header === "description" && i + 1 < lines.length) {
            metadata.description = lines[i + 1].trim();
          }
        }
      }
    }

    return {
      id: "",
      name: metadata.name || "Untitled Skill",
      version: metadata.version || "1.0.0",
      description: metadata.description || "",
      author: metadata.author,
      tools: metadata.tools,
      requiredProviders: metadata.requiredProviders,
    };
  }

  private extractTags(description: string): string[] {
    const hashtagRegex = /#[\w]+/g;
    const matches = description.match(hashtagRegex) || [];
    return matches.map((tag) => tag.slice(1));
  }

  private async saveIndex(): Promise<void> {
    try {
      const skillsList = Array.from(this.skills.values());
      await fs.writeFile(SKILLS_INDEX_FILE, JSON.stringify(skillsList, null, 2));
    } catch (error) {
      console.error("Failed to save skills index:", error);
    }
  }
}

export const skillsManager = new SkillsManager();
