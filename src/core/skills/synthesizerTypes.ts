export interface SkillTrajectoryStep {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: any;
  error?: string;
}

export type SkillRiskClassification = "low" | "medium" | "high";

export interface SkillEvidenceMetadata {
  /** Stable task link; never a raw transcript or command string. */
  taskId?: string;
  provider?: string;
  model?: string;
  executionMode?: "single" | "multi" | "interactive" | "background" | "unknown";
  errorSummary?: string;
  recoverySummary?: string;
  applicability?: string[];
  preconditions?: string[];
  expectedOutputs?: string[];
  verificationSteps?: string[];
  riskClassification?: SkillRiskClassification;
  knownLimitations?: string[];
  userFeedback?: { sentiment: "positive" | "negative" | "neutral"; summary: string };
}

export interface SkillSynthesisRequest {
  taskDescription: string;
  workspace: string;
  conversationTrajectory?: SkillTrajectoryStep[];
  skillName?: string;
  category?: string;
  /** Persisted Selfdev task_completed event IDs that can support candidate evaluation. */
  evidenceIds?: string[];
  /** Optional bounded provenance/context; values are redacted before persistence. */
  metadata?: SkillEvidenceMetadata;
}

export interface ExtractedWorkflowPatterns {
  toolsUsed: string[];
  commandPatterns: string[];
  recoveredErrors: string[];
  keySteps: string[];
}

export interface SynthesizedSkill {
  name: string;
  description: string;
  category: string;
  markdownContent: string;
  filePath: string;
  /** Content-addressed version identifier when the skill is stored as a candidate. */
  version?: string;
  extractedPatterns: ExtractedWorkflowPatterns;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SynthesizedSkillSummary {
  name: string;
  description: string;
  path: string;
  createdAt: number;
}
