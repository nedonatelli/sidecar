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
  type: 'pattern' | 'convention' | 'decision' | 'bug' | 'insight' | 'note' | 'toolchain' | 'failure';
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
  /** Session ID that created this memory (for current vs past session awareness) */
  sessionId?: string;
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
  private currentSessionId: string;

  constructor(sidecarDir: string) {
    this.memoryDir = path.join(sidecarDir, 'memory');
    this.currentSessionId = AgentMemory.generateSessionId();
    // Create directory if it doesn't exist
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  private static generateSessionId(): string {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Start a new session. Flushes the tool chain buffer and rotates the
   * session ID so new memories are tagged with the new session.
   * Call this on chat clear / new conversation.
   */
  startSession(): void {
    this.flushToolChain();
    this.currentSessionId = AgentMemory.generateSessionId();
  }

  /** Get the current session ID. */
  getSessionId(): string {
    return this.currentSessionId;
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
      let lowestScore = Infinity;

      for (const [id, entry] of this.memories) {
        // Low use count + old age = lowest score = eviction candidate
        const score = entry.useCount + (Date.now() - entry.timestamp) / (1000 * 60 * 60);
        if (score < lowestScore) {
          lowestScore = score;
          oldestId = id;
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
      sessionId: this.currentSessionId,
    };

    this.memories.set(id, entry);
    this.save(); // Auto-save

    return id;
  }

  /** Return all stored memories (for analytics/export). */
  queryAll(): MemoryEntry[] {
    return Array.from(this.memories.values());
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

        // Boost current-session memories so they rank higher than stale ones
        if (m.sessionId === this.currentSessionId) {
          score += 1.0;
        }

        return { ...m, relevanceScore: score };
      });

    const results = scored
      .filter((m) => m.relevanceScore > 0)
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, maxResults);

    // Track that these memories were actually used
    for (const m of results) {
      this.recordUse(m.id);
    }

    return results;
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

    const currentSession = memories.filter((m) => m.sessionId === this.currentSessionId);
    const pastSessions = memories.filter((m) => m.sessionId !== this.currentSessionId);

    const parts: string[] = [];

    if (currentSession.length > 0) {
      parts.push('## This Session\n');
      this.formatMemoryGroup(currentSession, parts);
    }

    if (pastSessions.length > 0) {
      parts.push('\n## Learned from Past Sessions (not this conversation)\n');
      this.formatMemoryGroup(pastSessions, parts);
    }

    return parts.join('\n');
  }

  private formatMemoryGroup(memories: MemoryEntry[], parts: string[]): void {
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
  }

  /**
   * Get total number of memories.
   */
  getCount(): number {
    return this.memories.size;
  }

  /**
   * Get memories relevant to a query, with scoring based on content similarity.
   */
  getRelevantMemories(query: string, maxResults: number = 5): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    const scoredMemories: { entry: MemoryEntry; score: number }[] = [];

    for (const entry of this.memories.values()) {
      let score = 0;

      // Score based on content similarity
      if (entry.content.toLowerCase().includes(lowerQuery)) {
        score += 0.5;
      }

      // Score based on category similarity
      if (entry.category.toLowerCase().includes(lowerQuery)) {
        score += 0.3;
      }

      // Score based on type similarity
      if (entry.type.toLowerCase().includes(lowerQuery)) {
        score += 0.2;
      }

      // Boost score for recent entries
      const age = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24); // days
      if (age < 7) score += 0.2; // recent entries get a boost

      if (score > 0.1) {
        scoredMemories.push({ entry, score });
      }
    }

    // Sort by score and return top results
    scoredMemories.sort((a, b) => b.score - a.score);
    return scoredMemories.slice(0, maxResults).map((item) => item.entry);
  }

  // --- Tool chain tracking ---

  /** Buffer of tool names used in the current session, for chain detection. */
  private sessionToolBuffer: string[] = [];

  /**
   * Record a tool use in the current session. When the session ends or a
   * chain of 3+ tools is detected, store it as a 'toolchain' memory.
   */
  recordToolUse(toolName: string, succeeded: boolean): void {
    if (succeeded) {
      this.sessionToolBuffer.push(toolName);
    } else {
      // On failure, flush any accumulated chain and start fresh
      this.flushToolChain();
      this.sessionToolBuffer = [];
    }
  }

  /**
   * Flush the tool chain buffer — store a 'toolchain' memory if 3+ tools were used.
   * Call this at the end of an agent loop.
   */
  flushToolChain(): void {
    if (this.sessionToolBuffer.length < 3) {
      this.sessionToolBuffer = [];
      return;
    }

    // Deduplicate consecutive repeats: [read, read, edit, edit, diagnostics] → [read, edit, diagnostics]
    const deduped: string[] = [];
    for (const t of this.sessionToolBuffer) {
      if (deduped[deduped.length - 1] !== t) deduped.push(t);
    }

    if (deduped.length >= 2) {
      const chain = deduped.join(' → ');
      // Check for duplicate chains already stored
      const isDuplicate = Array.from(this.memories.values()).some((m) => m.type === 'toolchain' && m.content === chain);
      if (!isDuplicate) {
        this.add('toolchain', 'tool-sequence', chain);
      }
    }
    this.sessionToolBuffer = [];
  }

  // --- Co-occurrence scoring ---

  /**
   * Build a co-occurrence map: for each tool, which other tools appear in the
   * same toolchain memories? Returns a map of tool → Set<co-occurring tools>.
   */
  getToolCooccurrences(): Map<string, Set<string>> {
    const cooccur = new Map<string, Set<string>>();
    for (const m of this.memories.values()) {
      if (m.type !== 'toolchain') continue;
      const tools = m.content.split(' → ').map((t) => t.trim());
      for (const tool of tools) {
        if (!cooccur.has(tool)) cooccur.set(tool, new Set());
        for (const other of tools) {
          if (other !== tool) cooccur.get(tool)!.add(other);
        }
      }
    }
    return cooccur;
  }

  /**
   * Suggest likely next tools based on what tools have been used so far
   * in the current session, using co-occurrence data from past chains.
   */
  suggestNextTools(recentTools: string[], maxSuggestions: number = 3): string[] {
    const cooccur = this.getToolCooccurrences();
    const candidates = new Map<string, number>();
    const recentSet = new Set(recentTools);

    for (const tool of recentTools) {
      const related = cooccur.get(tool);
      if (!related) continue;
      for (const r of related) {
        if (!recentSet.has(r)) {
          candidates.set(r, (candidates.get(r) || 0) + 1);
        }
      }
    }

    return Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxSuggestions)
      .map(([name]) => name);
  }
}
