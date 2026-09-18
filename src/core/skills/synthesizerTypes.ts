export interface SkillTrajectoryStep {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: any;
  error?: string;
}

export interface SkillSynthesisRequest {
  taskDescription: string;
  workspace: string;
  conversationTrajectory?: SkillTrajectoryStep[];
  skillName?: string;
  category?: string;
  targetDir?: string;
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
