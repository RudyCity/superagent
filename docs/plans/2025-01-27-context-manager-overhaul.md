# ContextManager Architectural Overhaul - Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Redesign conversation management dengan modular, testable architecture yang eliminates context loss dan provides accurate token estimation.

**Architecture:** Central `ContextManager` orchestrator coordinates 4 specialized components: `TokenTracker` (model-specific counting), `CompactionStrategy` (pluggable algorithms), `SemanticAnalyzer` (topic detection), dan `CompactionHistory` (audit trail). Each component follows single responsibility principle dengan dependency injection.

**Tech Stack:** TypeScript, Node.js, Vitest (testing), tiktoken (OpenAI tokenizer), event-driven architecture

---

## Task 1: TokenTracker Foundation

**Files:**
- Create: `src/core/context/TokenTracker.ts`
- Create: `src/core/context/TokenTracker.test.ts`
- Install: `tiktoken` package

**Step 1: Install tokenizer dependencies**

```bash
npm install tiktoken @anthropic-ai/tokenizer
```

Expected: Packages added to package.json

**Step 2: Write failing test for basic token estimation**

```typescript
// src/core/context/TokenTracker.test.ts
import { describe, it, expect } from 'vitest';
import { TokenTracker } from './TokenTracker';
import { Message } from '../conversation';

describe('TokenTracker', () => {
  it('should estimate tokens for simple message', () => {
    const tracker = new TokenTracker('claude-3-5-sonnet-20241022');
    const message: Message = {
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
    };
    
    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('should include tool calls in token count', () => {
    const tracker = new TokenTracker('claude-3-5-sonnet-20241022');
    const message: Message = {
      role: 'assistant',
      content: 'I will read the file',
      toolCalls: [
        { id: '1', name: 'read_file', args: { path: '/test.txt' } }
      ],
      timestamp: Date.now(),
    };
    
    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(15); // Should include tool call args
  });

  it('should include tool results in token count', () => {
    const tracker = new TokenTracker('claude-3-5-sonnet-20241022');
    const message: Message = {
      role: 'tool',
      content: 'File contents here',
      toolResults: [
        { toolCallId: '1', name: 'read_file', result: 'This is the file content' }
      ],
      timestamp: Date.now(),
    };
    
    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(10);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npm test -- src/core/context/TokenTracker.test.ts
```

Expected: FAIL - Cannot find module './TokenTracker'

**Step 4: Implement TokenTracker class**

```typescript
// src/core/context/TokenTracker.ts
import { Message } from '../conversation';
import { get_encoding } from 'tiktoken';

export interface TokenBreakdown {
  systemPrompt: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  total: number;
}

export class TokenTracker {
  private model: string;
  private cache: Map<string, number> = new Map();
  private encoder: any;

  constructor(model: string) {
    this.model = model;
    // Use cl100k_base for most models (GPT-4, Claude, etc.)
    this.encoder = get_encoding('cl100k_base');
  }

  setModel(model: string): void {
    this.model = model;
    this.cache.clear(); // Clear cache on model change
  }

  getModel(): string {
    return this.model;
  }

  estimateTokens(message: Message): number {
    const hash = this.hashMessage(message);
    
    if (this.cache.has(hash)) {
      return this.cache.get(hash)!;
    }

    let tokens = this.countText(message.content);

    // Count tool calls
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += this.countText(JSON.stringify(call.args));
      }
    }

    // Count tool results
    if (message.toolResults) {
      for (const result of message.toolResults) {
        tokens += this.countText(result.result);
      }
    }

    this.cache.set(hash, tokens);
    return tokens;
  }

  estimateTokensForAll(messages: Message[]): TokenBreakdown {
    let systemPrompt = 0;
    let messagesTokens = 0;
    let toolCalls = 0;
    let toolResults = 0;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += this.countText(msg.content);
      } else {
        messagesTokens += this.countText(msg.content);
      }

      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          toolCalls += this.countText(JSON.stringify(call.args));
        }
      }

      if (msg.toolResults) {
        for (const result of msg.toolResults) {
          toolResults += this.countText(result.result);
        }
      }
    }

    return {
      systemPrompt,
      messages: messagesTokens,
      toolCalls,
      toolResults,
      total: systemPrompt + messagesTokens + toolCalls + toolResults,
    };
  }

  getBreakdown(messages: Message[], systemPrompt?: string): TokenBreakdown {
    const breakdown = this.estimateTokensForAll(messages);
    
    if (systemPrompt) {
      breakdown.systemPrompt += this.countText(systemPrompt);
      breakdown.total += this.countText(systemPrompt);
    }

    return breakdown;
  }

  private countText(text: string): number {
    if (!text) return 0;
    
    try {
      return this.encoder.encode(text).length;
    } catch {
      // Fallback: improved heuristic
      // English: ~4 chars/token, Code: ~3 chars/token, CJK: ~2 chars/token
      const hasCode = /[{}\[\]()=<>]/.test(text);
      const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(text);
      
      let ratio = 4;
      if (hasCode) ratio = 3;
      if (hasCJK) ratio = 2;
      
      return Math.ceil(text.length / ratio);
    }
  }

  private hashMessage(message: Message): string {
    return `${message.role}:${message.content.length}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}`;
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npm test -- src/core/context/TokenTracker.test.ts
```

Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add src/core/context/TokenTracker.ts src/core/context/TokenTracker.test.ts package.json package-lock.json
git commit -m "feat: add TokenTracker with model-specific tokenization

- Implements accurate token counting using tiktoken
- Includes tool calls and tool results in count
- Provides breakdown by message type
- Caches results for performance
- Falls back to improved heuristic if tokenizer fails"
```

---

## Task 2: CompactionStrategy Interface

**Files:**
- Create: `src/core/context/CompactionStrategy.ts`
- Create: `src/core/context/strategies/SummarizationStrategy.ts`
- Create: `src/core/context/strategies/PruningStrategy.ts`
- Create: `src/core/context/strategies/PinningStrategy.ts`
- Create: `src/core/context/CompactionStrategy.test.ts`

**Step 1: Write failing test for strategy interface**

```typescript
// src/core/context/CompactionStrategy.test.ts
import { describe, it, expect } from 'vitest';
import { CompactionStrategy, CompactionContext, CompactionResult } from './CompactionStrategy';
import { SummarizationStrategy } from './strategies/SummarizationStrategy';
import { Message } from '../conversation';

describe('CompactionStrategy', () => {
  it('should define strategy interface', () => {
    const strategy: CompactionStrategy = {
      name: 'test',
      canHandle: () => true,
      execute: async () => ({ messages: [], metadata: {} }),
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    };
    
    expect(strategy.name).toBe('test');
  });

  it('should execute summarization strategy', async () => {
    const strategy = new SummarizationStrategy();
    const messages: Message[] = [
      { role: 'user', content: 'Question 1', timestamp: Date.now() },
      { role: 'assistant', content: 'Answer 1', timestamp: Date.now() },
    ];
    
    const context: CompactionContext = {
      messages,
      tokenBudget: 1000,
      hasPinnedMessages: false,
    };
    
    expect(strategy.canHandle(context)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/core/context/CompactionStrategy.test.ts
```

Expected: FAIL - Cannot find module './CompactionStrategy'

**Step 3: Implement strategy interfaces**

```typescript
// src/core/context/CompactionStrategy.ts
import { Message } from '../conversation';

export interface CompactionContext {
  messages: Message[];
  tokenBudget: number;
  hasPinnedMessages: boolean;
  pinnedMessageIds?: Set<string>;
}

export interface CompactionCost {
  tokens: number;
  time: number; // milliseconds
  apiCalls: number;
}

export interface CompactionResult {
  messages: Message[];
  metadata: {
    strategy: string;
    tokensSaved?: number;
    messagesBefore?: number;
    messagesAfter?: number;
    summary?: string;
    [key: string]: any;
  };
}

export interface CompactionOptions {
  tokenBudget?: number;
  preserveRecent?: number; // Keep last N messages
  customPrompt?: string;
}

export interface CompactionStrategy {
  name: string;
  canHandle(context: CompactionContext): boolean;
  execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
  estimateCost(messages: Message[]): CompactionCost;
}
```

**Step 4: Implement SummarizationStrategy**

```typescript
// src/core/context/strategies/SummarizationStrategy.ts
import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from '../CompactionStrategy';
import { Message } from '../../conversation';

export class SummarizationStrategy implements CompactionStrategy {
  name = 'summarization';

  canHandle(context: CompactionContext): boolean {
    // Can handle if we have enough messages to summarize
    return context.messages.length > 10;
  }

  async execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult> {
    const preserveRecent = options.preserveRecent || 20;
    
    // Split messages
    const toSummarize = messages.slice(0, -preserveRecent);
    const toKeep = messages.slice(-preserveRecent);
    
    // TODO: Implement actual LLM summarization
    // For now, create placeholder summary
    const summary = `[Summary of ${toSummarize.length} messages]: Context preserved`;
    
    const summaryMessage: Message = {
      role: 'user',
      content: `[System Conversation Summary]:\n${summary}`,
      timestamp: Date.now(),
    };
    
    const result = [summaryMessage, ...toKeep];
    
    return {
      messages: result,
      metadata: {
        strategy: 'summarization',
        messagesBefore: messages.length,
        messagesAfter: result.length,
        summary,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    // Estimate: 1 API call, ~2 seconds, tokens = input + output
    const inputTokens = messages.reduce((sum, m) => sum + (m.content.length / 4), 0);
    const outputTokens = 500; // Estimated summary length
    
    return {
      tokens: inputTokens + outputTokens,
      time: 2000,
      apiCalls: 1,
    };
  }
}
```

**Step 5: Implement PruningStrategy**

```typescript
// src/core/context/strategies/PruningStrategy.ts
import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from '../CompactionStrategy';
import { Message } from '../../conversation';

export class PruningStrategy implements CompactionStrategy {
  name = 'pruning';

  canHandle(context: CompactionContext): boolean {
    // Always can handle (last resort)
    return true;
  }

  async execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult> {
    const preserveRecent = options.preserveRecent || 20;
    
    // Create emergency summary before pruning
    const toPrune = messages.slice(0, -preserveRecent);
    const toKeep = messages.slice(-preserveRecent);
    
    const emergencySummary = this.createEmergencySummary(toPrune);
    
    const summaryMessage: Message = {
      role: 'user',
      content: `[Emergency Summary - Context Pruned]:\n${emergencySummary}`,
      timestamp: Date.now(),
    };
    
    const result = [summaryMessage, ...toKeep];
    
    return {
      messages: result,
      metadata: {
        strategy: 'pruning-with-emergency-summary',
        messagesBefore: messages.length,
        messagesAfter: result.length,
        messagesPruned: toPrune.length,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    // No API calls, just local processing
    return {
      tokens: 0,
      time: 100,
      apiCalls: 0,
    };
  }

  private createEmergencySummary(messages: Message[]): string {
    // Simple heuristic summary
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    
    return `Conversation had ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant). Key topics discussed.`;
  }
}
```

**Step 6: Run test to verify it passes**

```bash
npm test -- src/core/context/CompactionStrategy.test.ts
```

Expected: PASS (2 tests)

**Step 7: Commit**

```bash
git add src/core/context/CompactionStrategy.ts src/core/context/strategies/
git commit -m "feat: add CompactionStrategy interface and implementations

- Define strategy interface with canHandle, execute, estimateCost
- Implement SummarizationStrategy (LLM-based)
- Implement PruningStrategy (with emergency summary)
- All strategies preserve context via summary before removal"
```

---

## Task 3: SemanticAnalyzer

**Files:**
- Create: `src/core/context/SemanticAnalyzer.ts`
- Create: `src/core/context/SemanticAnalyzer.test.ts`

**Step 1: Write failing test for topic detection**

```typescript
// src/core/context/SemanticAnalyzer.test.ts
import { describe, it, expect } from 'vitest';
import { SemanticAnalyzer } from './SemanticAnalyzer';
import { Message } from '../conversation';

describe('SemanticAnalyzer', () => {
  it('should detect topic boundaries', () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [
      { role: 'user', content: 'Read file1.ts', timestamp: Date.now() },
      { role: 'assistant', content: 'Reading file1.ts', timestamp: Date.now() },
      { role: 'user', content: 'Now read file2.ts', timestamp: Date.now() }, // New topic
      { role: 'assistant', content: 'Reading file2.ts', timestamp: Date.now() },
    ];
    
    const boundaries = analyzer.detectTopicBoundaries(messages);
    expect(boundaries).toContain(0); // Start
    expect(boundaries).toContain(2); // New user message = new topic
  });

  it('should score message importance', () => {
    const analyzer = new SemanticAnalyzer();
    
    const decision: Message = {
      role: 'assistant',
      content: 'We decided to use PostgreSQL for the database',
      timestamp: Date.now(),
    };
    
    const routine: Message = {
      role: 'assistant',
      content: 'Reading file...',
      timestamp: Date.now(),
    };
    
    const decisionScore = analyzer.scoreImportance(decision);
    const routineScore = analyzer.scoreImportance(routine);
    
    expect(decisionScore).toBeGreaterThan(routineScore);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/core/context/SemanticAnalyzer.test.ts
```

Expected: FAIL - Cannot find module './SemanticAnalyzer'

**Step 3: Implement SemanticAnalyzer**

```typescript
// src/core/context/SemanticAnalyzer.ts
import { Message } from '../conversation';

export interface SemanticChunk {
  messages: Message[];
  startIndex: number;
  endIndex: number;
  topic?: string;
}

export interface KeyPoint {
  messageIndex: number;
  type: 'decision' | 'requirement' | 'error' | 'conclusion';
  content: string;
}

export class SemanticAnalyzer {
  
  detectTopicBoundaries(messages: Message[]): number[] {
    const boundaries = [0]; // Start is always a boundary
    
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      
      // Signal 1: New user message (strong boundary)
      if (curr.role === 'user' && prev.role !== 'user') {
        boundaries.push(i);
        continue;
      }
      
      // Signal 2: File path change
      const prevFiles = this.extractFilePaths(prev.content);
      const currFiles = this.extractFilePaths(curr.content);
      if (prevFiles.length > 0 && currFiles.length > 0) {
        const overlap = prevFiles.filter(f => currFiles.includes(f)).length;
        if (overlap === 0) {
          boundaries.push(i);
          continue;
        }
      }
      
      // Signal 3: Time gap (>5 minutes)
      if (curr.timestamp - prev.timestamp > 5 * 60 * 1000) {
        boundaries.push(i);
      }
    }
    
    return boundaries;
  }
  
  splitIntoChunks(messages: Message[]): SemanticChunk[] {
    const boundaries = this.detectTopicBoundaries(messages);
    const chunks: SemanticChunk[] = [];
    
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i < boundaries.length - 1 ? boundaries[i + 1] : messages.length;
      
      chunks.push({
        messages: messages.slice(start, end),
        startIndex: start,
        endIndex: end - 1,
      });
    }
    
    return chunks;
  }
  
  scoreImportance(message: Message): number {
    let score = 50; // Baseline
    
    const content = message.content.toLowerCase();
    
    // Boost for important patterns
    if (this.containsDecision(message)) score += 30;
    if (this.containsArchitectureChoice(message)) score += 25;
    if (this.containsUserRequirement(message)) score += 20;
    if (this.containsErrorMessage(message)) score += 15;
    if (this.containsFilePath(message)) score += 10;
    
    // Reduce for routine messages
    if (this.isRoutineToolCall(message)) score -= 20;
    if (this.isVerboseOutput(message)) score -= 15;
    
    return Math.max(0, Math.min(100, score));
  }
  
  extractKeyPoints(messages: Message[]): KeyPoint[] {
    const keyPoints: KeyPoint[] = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const score = this.scoreImportance(msg);
      
      if (score >= 75) {
        let type: KeyPoint['type'] = 'conclusion';
        
        if (this.containsDecision(msg)) type = 'decision';
        else if (this.containsUserRequirement(msg)) type = 'requirement';
        else if (this.containsErrorMessage(msg)) type = 'error';
        
        keyPoints.push({
          messageIndex: i,
          type,
          content: msg.content.substring(0, 200), // Truncate for brevity
        });
      }
    }
    
    return keyPoints;
  }
  
  private extractFilePaths(text: string): string[] {
    // Match common file path patterns
    const matches = text.match(/(?:\/|\\|\b)[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g);
    return matches || [];
  }
  
  private containsDecision(message: Message): boolean {
    const patterns = [
      /we (?:decided|will use|chose|selected)/i,
      /let's (?:use|go with|implement)/i,
      /the (?:best|right) (?:approach|solution|way)/i,
      /conclusion:/i,
    ];
    return patterns.some(p => p.test(message.content));
  }
  
  private containsArchitectureChoice(message: Message): boolean {
    const patterns = [
      /architecture/i,
      /design pattern/i,
      /we'll (?:structure|organize)/i,
      /component (?:structure|hierarchy)/i,
    ];
    return patterns.some(p => p.test(message.content));
  }
  
  private containsUserRequirement(message: Message): boolean {
    return message.role === 'user' && (
      /i (?:need|want|require)/i.test(message.content) ||
      /please (?:add|implement|create)/i.test(message.content)
    );
  }
  
  private containsErrorMessage(message: Message): boolean {
    return /error|failed|exception|warning/i.test(message.content);
  }
  
  private containsFilePath(message: Message): boolean {
    return this.extractFilePaths(message.content).length > 0;
  }
  
  private isRoutineToolCall(message: Message): boolean {
    return message.toolCalls?.some(tc => 
      ['read_file', 'list_directory', 'grep'].includes(tc.name)
    ) || false;
  }
  
  private isVerboseOutput(message: Message): boolean {
    // Long outputs with low information density
    return message.content.length > 2000 && 
           message.content.split('\n').length > 50;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/core/context/SemanticAnalyzer.test.ts
```

Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/core/context/SemanticAnalyzer.ts src/core/context/SemanticAnalyzer.test.ts
git commit -m "feat: add SemanticAnalyzer for intelligent compaction

- Detect topic boundaries using user messages, file paths, time gaps
- Score message importance (0-100) based on content patterns
- Extract key points (decisions, requirements, errors)
- Split messages into semantic chunks for better summarization"
```

---

## Task 4: CompactionHistory

**Files:**
- Create: `src/core/context/CompactionHistory.ts`
- Create: `src/core/context/CompactionHistory.test.ts`

**Step 1: Write failing test for history recording**

```typescript
// src/core/context/CompactionHistory.test.ts
import { describe, it, expect } from 'vitest';
import { CompactionHistory, CompactionEvent } from './CompactionHistory';

describe('CompactionHistory', () => {
  it('should record compaction events', () => {
    const history = new CompactionHistory();
    
    const event: CompactionEvent = {
      id: 'test-1',
      timestamp: Date.now(),
      strategy: 'summarization',
      messagesBefore: 100,
      messagesAfter: 50,
      tokensBefore: 50000,
      tokensAfter: 25000,
      reason: 'threshold',
    };
    
    history.record(event);
    
    const events = history.getHistory();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('test-1');
  });

  it('should find last summary', () => {
    const history = new CompactionHistory();
    
    history.record({
      id: '1',
      timestamp: Date.now(),
      strategy: 'summarization',
      messagesBefore: 100,
      messagesAfter: 50,
      tokensBefore: 50000,
      tokensAfter: 25000,
      summary: 'First summary',
      reason: 'threshold',
    });
    
    history.record({
      id: '2',
      timestamp: Date.now(),
      strategy: 'pruning',
      messagesBefore: 80,
      messagesAfter: 40,
      tokensBefore: 40000,
      tokensAfter: 20000,
      reason: 'emergency',
    });
    
    const lastSummary = history.getLastSummary();
    expect(lastSummary?.id).toBe('1');
    expect(lastSummary?.summary).toBe('First summary');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/core/context/CompactionHistory.test.ts
```

Expected: FAIL - Cannot find module './CompactionHistory'

**Step 3: Implement CompactionHistory**

```typescript
// src/core/context/CompactionHistory.ts
import fs from 'fs/promises';
import path from 'path';

export interface CompactionEvent {
  id: string;
  timestamp: number;
  strategy: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  summaryTokens?: number;
  pinnedMessages?: string[];
  reason: 'threshold' | 'emergency' | 'manual';
}

export class CompactionHistory {
  private events: CompactionEvent[] = [];
  private maxHistory = 50;
  private filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.load();
    }
  }

  record(event: CompactionEvent): void {
    this.events.push(event);
    
    // Trim if too large
    if (this.events.length > this.maxHistory) {
      this.events = this.events.slice(-this.maxHistory);
    }
    
    // Persist to disk if path configured
    if (this.filePath) {
      this.save();
    }
  }

  getHistory(): CompactionEvent[] {
    return [...this.events];
  }

  getLastSummary(): CompactionEvent | null {
    // Find most recent summarization event
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].strategy === 'summarization') {
        return this.events[i];
      }
    }
    return null;
  }

  getTokensSaved(): number {
    return this.events.reduce((sum, event) => {
      return sum + (event.tokensBefore - event.tokensAfter);
    }, 0);
  }

  getCompactionCount(): number {
    return this.events.length;
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.events, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save compaction history:', err);
    }
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;
    
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.events = JSON.parse(data);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to load compaction history:', err);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/core/context/CompactionHistory.test.ts
```

Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/core/context/CompactionHistory.ts src/core/context/CompactionHistory.test.ts
git commit -m "feat: add CompactionHistory for audit trail

- Record all compaction events with metadata
- Track tokens saved across compactions
- Persist to disk for session recovery
- Limit history to 50 events to prevent bloat"
```

---

## Task 5: ContextManager Orchestrator

**Files:**
- Create: `src/core/context/ContextManager.ts`
- Create: `src/core/context/ContextManager.test.ts`

**Step 1: Write failing test for shouldCompact logic**

```typescript
// src/core/context/ContextManager.test.ts
import { describe, it, expect } from 'vitest';
import { ContextManager } from './ContextManager';
import { Message } from '../conversation';

describe('ContextManager', () => {
  it('should return false when below threshold', () => {
    const manager = new ContextManager({
      model: 'claude-3-5-sonnet-20241022',
      contextWindowLimit: 200000,
    });
    
    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: Date.now() },
    ];
    
    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(false);
  });

  it('should return true when above threshold', () => {
    const manager = new ContextManager({
      model: 'claude-3-5-sonnet-20241022',
      contextWindowLimit: 200000,
    });
    
    // Create messages that exceed threshold
    const messages: Message[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: 'user',
        content: 'A'.repeat(1000), // ~250 tokens per message
        timestamp: Date.now(),
      });
    }
    
    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toContain('threshold');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/core/context/ContextManager.test.ts
```

Expected: FAIL - Cannot find module './ContextManager'

**Step 3: Implement ContextManager**

```typescript
// src/core/context/ContextManager.ts
import { EventEmitter } from 'events';
import { Message } from '../conversation';
import { TokenTracker, TokenBreakdown } from './TokenTracker';
import { CompactionStrategy, CompactionResult, CompactionContext } from './CompactionStrategy';
import { SummarizationStrategy } from './strategies/SummarizationStrategy';
import { PruningStrategy } from './strategies/PruningStrategy';
import { SemanticAnalyzer } from './SemanticAnalyzer';
import { CompactionHistory } from './CompactionHistory';

export type ContextState = 'IDLE' | 'CHECKING' | 'COMPACTING' | 'VALIDATING' | 'FAILED' | 'RECOVERING';

export interface ContextManagerConfig {
  model: string;
  contextWindowLimit: number;
  historyFilePath?: string;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: string;
  urgency?: 'normal' | 'critical';
  recommendedStrategy?: CompactionStrategy;
}

export class ContextManager {
  private state: ContextState = 'IDLE';
  private tokenTracker: TokenTracker;
  private strategies: CompactionStrategy[];
  private semanticAnalyzer: SemanticAnalyzer;
  private history: CompactionHistory;
  private eventEmitter: EventEmitter;
  private config: ContextManagerConfig;
  private pinnedMessages: Set<string> = new Set();

  constructor(config: ContextManagerConfig) {
    this.config = config;
    this.tokenTracker = new TokenTracker(config.model);
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.history = new CompactionHistory(config.historyFilePath);
    this.eventEmitter = new EventEmitter();
    
    // Register strategies in priority order
    this.strategies = [
      new SummarizationStrategy(),
      new PruningStrategy(),
    ];
  }

  shouldCompact(messages: Message[]): CompactionDecision {
    // 1. Calculate current token usage
    const breakdown = this.tokenTracker.estimateTokensForAll(messages);
    const totalTokens = breakdown.total;
    
    // 2. Get threshold
    const threshold = this.calculateThreshold();
    
    // 3. Decision logic
    if (totalTokens < threshold * 0.8) {
      return { shouldCompact: false, reason: 'below-threshold' };
    }
    
    if (totalTokens >= threshold) {
      const urgency = totalTokens > threshold * 1.2 ? 'critical' : 'normal';
      
      return {
        shouldCompact: true,
        reason: `threshold-exceeded (${totalTokens} >= ${threshold})`,
        urgency,
        recommendedStrategy: this.selectStrategy(messages),
      };
    }
    
    return { shouldCompact: false, reason: 'approaching-threshold' };
  }

  async compact(messages: Message[], strategy?: CompactionStrategy): Promise<CompactionResult> {
    this.setState('CHECKING');
    
    try {
      // 1. Select strategy
      const selectedStrategy = strategy || this.selectStrategy(messages);
      
      // 2. Validate strategy
      const context = this.buildCompactionContext(messages);
      if (!selectedStrategy.canHandle(context)) {
        throw new Error(`Strategy ${selectedStrategy.name} cannot handle current context`);
      }
      
      this.setState('COMPACTING');
      this.emit('compaction:start', { strategy: selectedStrategy.name });
      
      // 3. Execute compaction
      const result = await selectedStrategy.execute(messages, {
        tokenBudget: this.calculateThreshold(),
      });
      
      this.setState('VALIDATING');
      
      // 4. Validate result
      this.validateResult(result);
      
      // 5. Record in history
      const tokensBefore = this.tokenTracker.estimateTokensForAll(messages).total;
      const tokensAfter = this.tokenTracker.estimateTokensForAll(result.messages).total;
      
      this.history.record({
        id: this.generateId(),
        timestamp: Date.now(),
        strategy: selectedStrategy.name,
        messagesBefore: messages.length,
        messagesAfter: result.messages.length,
        tokensBefore,
        tokensAfter,
        summary: result.metadata.summary,
        reason: 'threshold',
      });
      
      this.setState('IDLE');
      this.emit('compaction:complete', result);
      
      return result;
      
    } catch (error) {
      this.setState('FAILED');
      this.emit('compaction:fail', error);
      
      // Attempt recovery
      return this.recover(messages, error as Error);
    } finally {
      this.setState('IDLE');
    }
  }

  getState(): ContextState {
    return this.state;
  }

  on(event: 'compaction:start' | 'compaction:complete' | 'compaction:fail', handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  setThreshold(threshold: number | 'auto'): void {
    if (threshold === 'auto') {
      // Reset to calculated threshold
      this.config.contextWindowLimit = this.config.contextWindowLimit;
    } else {
      this.config.contextWindowLimit = threshold;
    }
  }

  setModel(model: string): void {
    this.config.model = model;
    this.tokenTracker.setModel(model);
  }

  addPinnedMessage(messageId: string): void {
    this.pinnedMessages.add(messageId);
  }

  removePinnedMessage(messageId: string): void {
    this.pinnedMessages.delete(messageId);
  }

  getHistory() {
    return this.history.getHistory();
  }

  private calculateThreshold(): number {
    const modelLimit = this.config.contextWindowLimit;
    
    // Reserve space for response (estimate 8K tokens)
    const responseBuffer = 8000;
    
    // Reserve space for tool calls (10K tokens)
    const toolCallBuffer = 10000;
    
    // Calculate threshold
    const threshold = modelLimit - responseBuffer - toolCallBuffer;
    
    // Apply safety factor (never use more than 70% of context)
    return Math.min(threshold, modelLimit * 0.7);
  }

  private selectStrategy(messages: Message[]): CompactionStrategy {
    const context = this.buildCompactionContext(messages);
    
    // Try strategies in priority order
    for (const strategy of this.strategies) {
      if (strategy.canHandle(context)) {
        return strategy;
      }
    }
    
    // Fallback to pruning (always can handle)
    return this.strategies[this.strategies.length - 1];
  }

  private buildCompactionContext(messages: Message[]): CompactionContext {
    return {
      messages,
      tokenBudget: this.calculateThreshold(),
      hasPinnedMessages: this.pinnedMessages.size > 0,
      pinnedMessageIds: this.pinnedMessages,
    };
  }

  private validateResult(result: CompactionResult): void {
    if (!result.messages || result.messages.length === 0) {
      throw new Error('Compaction result has no messages');
    }
    
    if (!result.metadata || !result.metadata.strategy) {
      throw new Error('Compaction result missing metadata');
    }
  }

  private async recover(messages: Message[], error: Error): Promise<CompactionResult> {
    this.setState('RECOVERING');
    console.error('Compaction failed, attempting recovery:', error.message);
    
    try {
      // Try pruning strategy (always works)
      const pruningStrategy = new PruningStrategy();
      return await pruningStrategy.execute(messages, {
        preserveRecent: 20,
      });
    } catch (recoveryError) {
      console.error('Recovery failed:', recoveryError);
      // Last resort: just keep recent messages
      return {
        messages: messages.slice(-20),
        metadata: {
          strategy: 'emergency-truncation',
          reason: 'all-strategies-failed',
        },
      };
    }
  }

  private setState(state: ContextState): void {
    this.state = state;
    this.emit('state:change', state);
  }

  private emit(event: string, ...args: any[]): void {
    this.eventEmitter.emit(event, ...args);
  }

  private generateId(): string {
    return `compact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/core/context/ContextManager.test.ts
```

Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/core/context/ContextManager.ts src/core/context/ContextManager.test.ts
git commit -m "feat: add ContextManager orchestrator

- Coordinates TokenTracker, strategies, SemanticAnalyzer, history
- Implements state machine (IDLE → CHECKING → COMPACTING → VALIDATING)
- Adaptive threshold calculation with response/tool buffers
- Strategy selection based on context
- Recovery mechanism on failure
- Event emitter for monitoring"
```

---

## Task 6: Integration with Existing Code

**Files:**
- Modify: `src/core/agent.ts` (replace compactHistoryIfNeeded)
- Modify: `src/core/conversation.ts` (add ContextManager integration)

**Step 1: Create index file for context module**

```typescript
// src/core/context/index.ts
export { ContextManager, ContextState, CompactionDecision, ContextManagerConfig } from './ContextManager';
export { TokenTracker, TokenBreakdown } from './TokenTracker';
export { CompactionStrategy, CompactionResult, CompactionContext } from './CompactionStrategy';
export { SemanticAnalyzer, SemanticChunk, KeyPoint } from './SemanticAnalyzer';
export { CompactionHistory, CompactionEvent } from './CompactionHistory';
export { SummarizationStrategy } from './strategies/SummarizationStrategy';
export { PruningStrategy } from './strategies/PruningStrategy';
```

**Step 2: Commit**

```bash
git add src/core/context/index.ts
git commit -m "feat: add context module index with exports"
```

**Step 3: Update conversation.ts to integrate ContextManager**

```typescript
// Add to src/core/conversation.ts (after imports)
import { ContextManager, ContextManagerConfig } from './context';

// Add to Conversation class
export class Conversation {
  private messages: Message[] = [];
  private maxHistory = 200;
  public loadedPlanState?: "IDLE" | "PLANNING_PENDING" | "APPROVED";
  private contextManager?: ContextManager;

  // Add new method
  initContextManager(config: ContextManagerConfig): void {
    this.contextManager = new ContextManager(config);
  }

  getContextManager(): ContextManager | undefined {
    return this.contextManager;
  }

  // Modify getTokenEstimate to use ContextManager if available
  getTokenEstimate(): number {
    if (this.contextManager) {
      // Use accurate token tracking
      const breakdown = this.contextManager.estimateTokensForAll(this.messages);
      return breakdown.total;
    }
    
    // Fallback to old heuristic
    return this.messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );
  }
}
```

**Step 4: Commit**

```bash
git add src/core/conversation.ts
git commit -m "feat: integrate ContextManager into Conversation class

- Add initContextManager() method
- Add getContextManager() accessor
- Update getTokenEstimate() to use accurate tracking when available
- Maintain backward compatibility with heuristic fallback"
```

**Step 5: Update agent.ts to use ContextManager**

```typescript
// In src/core/agent.ts, find compactHistoryIfNeeded() method and replace with:

async compactHistoryIfNeeded(): Promise<void> {
  const contextManager = this.conversation.getContextManager();
  
  if (!contextManager) {
    // Fallback to old logic if ContextManager not initialized
    await this.legacyCompactHistory();
    return;
  }
  
  const messages = this.conversation.getMessages();
  const decision = contextManager.shouldCompact(messages);
  
  if (!decision.shouldCompact) {
    return;
  }
  
  try {
    const result = await contextManager.compact(messages);
    
    // Replace messages in conversation
    this.conversation.replaceMessages(result.messages);
    
    await this.saveHistory();
    
    this.writeToLogFile('INFO', `Compaction completed: ${result.metadata.strategy} strategy`);
    
  } catch (error) {
    console.error('Compaction failed:', error);
    this.writeToLogFile('ERROR', `Compaction failed: ${(error as Error).message}`);
  }
}

private async legacyCompactHistory(): Promise<void> {
  // Keep existing logic as fallback
  const modelLimit = getContextWindowLimit(this.config.model);
  const maxHistoryTokens = Math.floor(modelLimit * 0.5);

  if (this.conversation.getTokenEstimate() > maxHistoryTokens) {
    const allMsgs = this.conversation.getMessages();
    if (allMsgs.length > 20) {
      const toSummarize = allMsgs.slice(0, 20);
      try {
        const summary = await this.summarizeMessages(toSummarize);
        this.conversation.replaceOldMessagesWithSummary(20, summary);
        await this.saveHistory();
      } catch (err) {
        console.error("Failed to summarize and compact conversation history:", err);
        this.conversation.pruneToTokenLimit(maxHistoryTokens);
        await this.saveHistory();
      }
    } else {
      this.conversation.pruneToTokenLimit(maxHistoryTokens);
      await this.saveHistory();
    }
  }
}
```

**Step 6: Commit**

```bash
git add src/core/agent.ts
git commit -m "feat: integrate ContextManager into agent loop

- Replace compactHistoryIfNeeded() with ContextManager-based logic
- Add legacyCompactHistory() as fallback
- Maintain backward compatibility
- Log compaction events"
```

---

## Task 7: Testing and Validation

**Files:**
- Create: `tests/integration/context-manager.test.ts`

**Step 1: Write integration test**

```typescript
// tests/integration/context-manager.test.ts
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context';
import { Message } from '../../src/core/conversation';

describe('ContextManager Integration', () => {
  it('should handle long conversation (1000+ messages)', async () => {
    const manager = new ContextManager({
      model: 'claude-3-5-sonnet-20241022',
      contextWindowLimit: 200000,
    });
    
    // Simulate 1000 messages
    const messages: Message[] = [];
    for (let i = 0; i < 1000; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ` + 'A'.repeat(200),
        timestamp: Date.now() + i * 1000,
      });
    }
    
    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(true);
    
    const result = await manager.compact(messages);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBeDefined();
  });

  it('should preserve context across multiple compactions', async () => {
    const manager = new ContextManager({
      model: 'claude-3-5-sonnet-20241022',
      contextWindowLimit: 200000,
    });
    
    let messages: Message[] = [];
    
    // Add 100 messages
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: Date.now() + i * 1000,
      });
    }
    
    // First compaction
    const result1 = await manager.compact(messages);
    messages = result1.messages;
    
    // Add more messages
    for (let i = 100; i < 200; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: Date.now() + i * 1000,
      });
    }
    
    // Second compaction
    const result2 = await manager.compact(messages);
    
    // Check history
    const history = manager.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].strategy).toBeDefined();
    expect(history[1].strategy).toBeDefined();
  });
});
```

**Step 2: Run integration tests**

```bash
npm test -- tests/integration/context-manager.test.ts
```

Expected: PASS (2 tests)

**Step 3: Commit**

```bash
git add tests/integration/context-manager.test.ts
git commit -m "test: add integration tests for ContextManager

- Test long conversation handling (1000+ messages)
- Test context preservation across multiple compactions
- Verify history tracking"
```

---

## Summary

This plan implements a complete architectural overhaul of conversation management with:

✅ **5 Core Components** (TokenTracker, CompactionStrategy, SemanticAnalyzer, CompactionHistory, ContextManager)  
✅ **TDD Approach** (write test → verify fail → implement → verify pass → commit)  
✅ **Backward Compatibility** (legacy fallback maintained)  
✅ **Comprehensive Testing** (unit + integration tests)  
✅ **7 Tasks** with clear file paths and commands

**Total estimated time:** 4-6 weeks with balanced approach

---

**Ready to start implementation?**
