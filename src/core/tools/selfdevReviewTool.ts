import { getSelfDevLessonsPath } from "../config/paths.js";
import { getSettings } from "../config/jsonConfig.js";
import { ReviewService } from "../selfdev/reviewService.js";
import { getHistoryDb } from "../storage/historyDb.js";
import { SelfDevEventStore } from "../selfdev/eventStore.js";
import type { Tool } from "./types.js";
import type { SelfDevLessonStatus } from "../selfdev/types.js";

export const selfdevReviewTool: Tool = {
  name: "selfdev_review",
  description: "Inspect, approve, reject, retire, or edit Self-Dev behavioral lessons for the current workspace.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "inspect", "approve", "reject", "retire", "edit"],
        description: "Review action to execute.",
      },
      lessonId: {
        type: "string",
        description: "ID of the lesson to inspect, approve, reject, retire, or edit.",
      },
      version: {
        type: "number",
        description: "Expected version of the lesson to prevent concurrent modification conflicts.",
      },
      status: {
        type: "string",
        enum: ["candidate", "active", "retired"],
        description: "Optional filter for 'list' action.",
      },
      reason: {
        type: "string",
        description: "Required reason when retiring or rejecting a lesson.",
      },
      statement: {
        type: "string",
        description: "New statement text when editing a lesson.",
      },
      rationale: {
        type: "string",
        description: "New rationale text when editing a lesson.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "New tags when editing a lesson.",
      },
    },
    required: ["action"],
  },
  execute: async (args: Record<string, unknown>, cwd: string): Promise<string> => {
    const settings = getSettings();
    const config = settings.selfdev;

    const storePath = config?.storePath || getSelfDevLessonsPath();
    const eventStore = new SelfDevEventStore({
      workspace: cwd,
      getDb: () => getHistoryDb() as any,
      config,
    });

    const reviewService = new ReviewService({
      storePath,
      enabled: () => config?.enabled ?? false,
      eventStore,
    });

    const action = args.action as string;
    const lessonId = args.lessonId as string | undefined;
    const expectedVersion = typeof args.version === "number" ? args.version : undefined;

    try {
      switch (action) {
        case "list": {
          const status = args.status as SelfDevLessonStatus | undefined;
          const lessons = await reviewService.list(cwd, status);
          if (lessons.length === 0) {
            return `No ${status || ""} lessons found for workspace: ${cwd}`;
          }
          return JSON.stringify(lessons, null, 2);
        }

        case "inspect": {
          if (!lessonId) return "Error: lessonId is required for inspect action";
          const result = await reviewService.inspect(cwd, lessonId);
          if (!result) return `Lesson not found: ${lessonId}`;
          return JSON.stringify(result, null, 2);
        }

        case "approve": {
          if (!lessonId) return "Error: lessonId is required for approve action";
          if (expectedVersion === undefined) return "Error: version is required for approve action to verify revision";
          const approved = await reviewService.approve(cwd, lessonId, expectedVersion, "human_reviewer");
          return `Successfully approved lesson ${approved.id} (new version ${approved.version}, status: active)`;
        }

        case "reject": {
          if (!lessonId) return "Error: lessonId is required for reject action";
          if (expectedVersion === undefined) return "Error: version is required for reject action to verify revision";
          await reviewService.reject(cwd, lessonId, expectedVersion, (args.reason as string) || "rejected_by_user");
          return `Successfully rejected and deleted candidate lesson ${lessonId}`;
        }

        case "retire": {
          if (!lessonId) return "Error: lessonId is required for retire action";
          if (expectedVersion === undefined) return "Error: version is required for retire action to verify revision";
          const reason = args.reason as string;
          if (!reason || !reason.trim()) return "Error: reason is required when retiring an active lesson";
          const retired = await reviewService.retire(cwd, lessonId, expectedVersion, reason);
          return `Successfully retired lesson ${retired.id} (status: retired, reason: ${retired.retiredReason})`;
        }

        case "edit": {
          if (!lessonId) return "Error: lessonId is required for edit action";
          if (expectedVersion === undefined) return "Error: version is required for edit action to verify revision";
          const updated = await reviewService.edit(cwd, lessonId, expectedVersion, {
            statement: args.statement as string | undefined,
            rationale: args.rationale as string | undefined,
            tags: args.tags as string[] | undefined,
          });
          return `Successfully updated lesson ${updated.id} (version ${updated.version}, demoted to candidate for re-review)`;
        }

        default:
          return `Unknown review action: ${action}`;
      }
    } catch (err: any) {
      return `Self-dev review error: ${err?.message || String(err)}`;
    }
  },
};
