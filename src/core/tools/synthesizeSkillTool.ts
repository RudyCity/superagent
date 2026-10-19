import { Tool } from "./types.js";
import { synthesizeSkill } from "../skills/skillSynthesizer.js";

export const synthesizeSkillTool: Tool = {
  name: "synthesize_skill",
  description: "Synthesizes an inactive, versioned skill candidate from a workflow. Candidate is stored outside runtime discovery and requires verified Selfdev task evidence, evaluation, and explicit interactive CLI approval before activation.",
  parameters: {
    type: "object",
    properties: {
      taskDescription: {
        type: "string",
        description: "Clear summary of the task, problem solved, or workflow accomplished."
      },
      skillName: {
        type: "string",
        description: "Optional kebab-case identifier for the skill (e.g. 'sqlite-migration-helper')."
      },
      category: {
        type: "string",
        description: "Optional categorization for the skill (e.g. 'database', 'testing', 'refactor')."
      },
      evidenceIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional IDs of persisted Selfdev task_completed events. Evaluation verifies the exact workspace and linked successful test/build evidence."
      },
      metadata: {
        type: "object",
        description: "Optional structured provenance and applicability metadata. Values are bounded and redacted before persistence; never send raw prompts, transcripts, command strings, or credentials.",
        properties: {
          taskId: { type: "string", description: "Stable task ID matching the supplied verified Selfdev evidence." },
          provider: { type: "string", description: "Provider name only, not credentials." },
          model: { type: "string", description: "Model identifier only." },
          executionMode: { type: "string", enum: ["single", "multi", "interactive", "background", "unknown"] },
          errorSummary: { type: "string", description: "Short redacted error summary; no raw logs." },
          recoverySummary: { type: "string", description: "Short redacted description of the successful recovery." },
          applicability: { type: "array", items: { type: "string" }, description: "Tasks/workspaces where this workflow is appropriate." },
          preconditions: { type: "array", items: { type: "string" }, description: "Required checks before running the workflow." },
          expectedOutputs: { type: "array", items: { type: "string" }, description: "Expected bounded results or artifacts." },
          verificationSteps: { type: "array", items: { type: "string" }, description: "Independent checks to validate the result." },
          riskClassification: { type: "string", enum: ["low", "medium", "high"] },
          knownLimitations: { type: "array", items: { type: "string" }, description: "Known limitations or unverified assumptions." },
          userFeedback: {
            type: "object",
            properties: {
              sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
              summary: { type: "string", description: "Bounded feedback summary; no raw conversation." }
            }
          }
        }
      }
    },
    required: ["taskDescription"]
  },
  execute: async (args: Record<string, unknown>, cwd: string): Promise<string> => {
    const taskDescription = String(args.taskDescription || "").trim();
    if (!taskDescription) {
      return "Error: taskDescription is required.";
    }

    const skillName = args.skillName ? String(args.skillName).trim() : undefined;
    const category = args.category ? String(args.category).trim() : undefined;

    try {
      const result = await synthesizeSkill({
        taskDescription,
        workspace: cwd,
        skillName,
        category,
        evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((id): id is string => typeof id === "string") : undefined,
        metadata: args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
          ? args.metadata as import("../skills/synthesizerTypes.js").SkillEvidenceMetadata
          : undefined
      });

      return [
        `Skill successfully synthesized: ${result.name}`,
        `- Path: ${result.filePath}`,
        `- Description: ${result.description}`,
        `- Category: ${result.category}`,
        `- Key Tools: ${result.extractedPatterns.toolsUsed.join(", ") || "standard tools"}`,
        `Status: candidate (inactive; not loaded by runtime skill discovery).`,
        `Candidate reference: ${result.name}@${result.version || "unknown-version"}`,
        `Next: superagent skill evaluate ${result.name}@${result.version || "unknown-version"}`,
        `Promotion requires verified evidence and explicit interactive CLI approval.`
      ].join("\n");
    } catch (err: any) {
      return `Failed to synthesize skill: ${err.message || String(err)}`;
    }
  }
};
