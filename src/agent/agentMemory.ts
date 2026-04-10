import * as fs from 'fs';
import * as path from 'path';

/**
 * A persistent memory entry tracking patterns, conventions, or decisions
 * learned during agent interactions.
 */
export interface MemoryEntry {
  /** Unique identifier */
  id: string;
  /** Type: coding pattern, convention, decision, bug, etc. */
  type: 'pattern' | 'convention' | 'decision' | 'bug' | 'insight' | 'note';
  /** Category for grouping (e.g., "naming", "architecture", "testing") */
  category: string;
  /** The actual memory content */
  content: string;
  /** When this was added/updated */
  timestamp: number;
  /** How many times this has been referenced */
  useCount: number;
  /** Optional context (file, function, test case) */
  context?: string;
  /** Relevance score for retrieval (0-1) */
  relevanceScore?: number;
}

/**
 * Agent memory manager for persistent per-workspace learning.
 * Stores patterns, conventions, decisions, and insights for reuse across sessions.
 */
export class AgentMemory {
  private memories = new Map<string, MemoryEntry>();
  private memoryDir: string;
  private readonly MAX_MEMORIES = 500;
  private readonly MEMORY_FILE = 'agent-memories.json';

  constructor(sidecarDir: string) {
    this.memoryDir = path.join(sidecarDir, 'memory');
    // Create directory if it doesn't exist
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  /**
   * Load memories from persistent storage.
   */
  async load(): Promise<void> {
    try {
      const filePath = path.join(this.memoryDir, this.MEMORY_FILE);
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (Array.isArray(data.memories)) {
        for (const entry of data.memories) {
          this.memories.set(entry.id, entry);
        }
      }
      console.log(`[SideCar] Loaded ${this.memories.size} agent memories from persistent storage`);
    } catch (error) {
      console.warn('[SideCar] Failed to load agent memories:', error);
    }
  }

  /**
   * Save memories to persistent storage.
   */
  async save(): Promise<void> {
    try {
      const filePath = path.join(this.memoryDir, this.MEMORY_FILE);
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        memories: Array.from(this.memories.values()),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[SideCar] Failed to save agent memories:', error);
    }
  }

  /**
   * Add a new memory entry.
   */
  add(type: MemoryEntry['type'], category: string, content: string, context?: string): string {
    // Enforce memory limit
    if (this.memories.size >= this.MAX_MEMORIES) {
      // Remove oldest least-used entry
      let oldestId = '';
      let oldestTime = Infinity;
      let _minUseCount = Infinity;

      for (const [id, entry] of this.memories) {
        const score = entry.useCount + (Date.now() - entry.timestamp) / (1000 * 60 * 60); // age factor
        if (score < oldestTime) {
          oldestTime = score;
          oldestId = id;
          _minUseCount = entry.useCount;
        }
      }

      if (oldestId) {
        this.memories.delete(oldestId);
      }
    }

    const id = `${type}-${category}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const entry: MemoryEntry = {
      id,
      type,
      category,
      content,
      timestamp: Date.now(),
      useCount: 0,
      context,
    };

    this.memories.set(id, entry);
    this.save(); // Auto-save

    return id;
  }

  /**
   * Search memories by category or full-text search on content.
   */
  search(query: string, category?: string, maxResults: number = 5): MemoryEntry[] {
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scored = Array.from(this.memories.values())
      .filter((m) => !category || m.category === category)
      .map((m) => {
        let score = 0;
        const contentLower = m.content.toLowerCase();
        const categoryLower = m.category.toLowerCase();

        for (const term of queryTerms) {
          if (categoryLower.includes(term)) score += 2;
          if (contentLower.includes(term)) score += 1;
        }

        // Boost recently accessed memories
        const ageMinutes = (Date.now() - m.timestamp) / (1000 * 60);
        const recencyBoost = Math.max(0, 1 - ageMinutes / (7 * 24 * 60)); // Decay over week
        score += recencyBoost * 0.5;

        return { ...m, relevanceScore: score };
      });

    return scored
      .filter((m) => m.relevanceScore > 0)
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, maxResults);
  }

  /**
   * Get all memories of a specific type.
   */
  getByType(type: MemoryEntry['type']): MemoryEntry[] {
    return Array.from(this.memories.values()).filter((m) => m.type === type);
  }

  /**
   * Get all categories available in memory.
   */
  getCategories(): string[] {
    const categories = new Set<string>();
    for (const memory of this.memories.values()) {
      categories.add(memory.category);
    }
    return Array.from(categories).sort();
  }

  /**
   * Increment use count for a memory (call when memory is referenced).
   */
  recordUse(id: string): void {
    const memory = this.memories.get(id);
    if (memory) {
      memory.useCount++;
      this.save();
    }
  }

  /**
   * Delete a memory entry.
   */
  delete(id: string): boolean {
    const deleted = this.memories.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  /**
   * Clear all memories.
   */
  clear(): void {
    this.memories.clear();
    this.save();
  }

  /**
   * Get memory statistics.
   */
  getStats(): { totalCount: number; byType: Record<string, number>; byCategory: Record<string, number> } {
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const memory of this.memories.values()) {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
      byCategory[memory.category] = (byCategory[memory.category] || 0) + 1;
    }

    return {
      totalCount: this.memories.size,
      byType,
      byCategory,
    };
  }

  /**
   * Format memories for inclusion in chat context.
   */
  formatForContext(memories: MemoryEntry[]): string {
    if (memories.length === 0) return '';

    const parts = ['## Agent Memory\n'];

    // Group by type
    const byType: Record<string, MemoryEntry[]> = {};
    for (const m of memories) {
      if (!byType[m.type]) byType[m.type] = [];
      byType[m.type].push(m);
    }

    for (const [type, entries] of Object.entries(byType)) {
      parts.push(`\n### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`);
      for (const entry of entries) {
        parts.push(`- **${entry.category}**: ${entry.content.slice(0, 200)}`);
        if (entry.useCount > 3) {
          parts.push(` [used ${entry.useCount} times]`);
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Get total number of memories.
   */
  getCount(): number {
    return this.memories.size;
  }
}
