import type { SystemResourceSample, ResourcePressureLevel } from "./cliBridgeResourceSampler.js";

export type JobPriority = "critical" | "high" | "normal" | "low";
export type ResourceClass = "light" | "normal" | "heavy" | "exclusive";

export interface SchedulerPolicy {
  minSlots: number;
  maxSlots: number;
  configuredSlots: number;
  cooldownMs: number;
  perProjectQuota: number;
  maxHeavyJobs: number;
}

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = {
  minSlots: 2,
  maxSlots: 8,
  configuredSlots: 4,
  cooldownMs: 5000,
  perProjectQuota: 4,
  maxHeavyJobs: 1,
};

export interface ScheduledJobRequest {
  jobId: string;
  projectId: string;
  ownerId?: string;
  cliAlias: string;
  priority: JobPriority;
  resourceClass: ResourceClass;
  createdAt: number;
}

export interface AdmissionDecision {
  admitted: boolean;
  effectiveSlots: number;
  pressure: ResourcePressureLevel;
  reason?: string;
}

const PRIORITY_BASE_WEIGHTS: Record<JobPriority, number> = {
  critical: 1000,
  high: 500,
  normal: 200,
  low: 50,
};

/**
 * Dynamically computes effective capacity slots between minSlots and maxSlots.
 * Scale downs under pressure are immediate; scale ups respect a hysteresis cooldown.
 */
export function calculateEffectiveSlots(
  sample: SystemResourceSample,
  policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY,
  currentEffective: number = policy.configuredSlots,
  lastScaleChangeAt: number = 0,
  now: number = Date.now()
): { effectiveSlots: number; changed: boolean; timestamp: number } {
  let targetSlots: number;

  switch (sample.pressure) {
    case "critical":
      targetSlots = policy.minSlots;
      break;
    case "high":
      targetSlots = Math.max(policy.minSlots, Math.min(3, policy.configuredSlots));
      break;
    case "moderate":
      targetSlots = Math.max(policy.minSlots, Math.min(4, policy.configuredSlots));
      break;
    case "none":
    default:
      targetSlots = Math.max(policy.minSlots, Math.min(policy.maxSlots, policy.configuredSlots));
      break;
  }

  targetSlots = Math.max(policy.minSlots, Math.min(policy.maxSlots, targetSlots));

  // If scaling down, apply immediately
  if (targetSlots < currentEffective) {
    return {
      effectiveSlots: targetSlots,
      changed: true,
      timestamp: now,
    };
  }

  // If scaling up, enforce hysteresis cooldown
  if (targetSlots > currentEffective) {
    if (now - lastScaleChangeAt < policy.cooldownMs) {
      return {
        effectiveSlots: currentEffective,
        changed: false,
        timestamp: lastScaleChangeAt,
      };
    }
    return {
      effectiveSlots: targetSlots,
      changed: true,
      timestamp: now,
    };
  }

  return {
    effectiveSlots: currentEffective,
    changed: false,
    timestamp: lastScaleChangeAt,
  };
}

/**
 * Evaluates whether a specific job request can be admitted given current active jobs and capacity.
 */
export function evaluateJobAdmission(
  job: ScheduledJobRequest,
  activeJobs: ScheduledJobRequest[],
  effectiveSlots: number,
  pressure: ResourcePressureLevel = "none",
  policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY
): AdmissionDecision {
  // 1. Exclusive job check
  const hasActiveExclusive = activeJobs.some((j) => j.resourceClass === "exclusive");
  if (hasActiveExclusive) {
    return {
      admitted: false,
      effectiveSlots,
      pressure,
      reason: "Exclusive job currently running on host",
    };
  }

  if (job.resourceClass === "exclusive" && activeJobs.length > 0) {
    return {
      admitted: false,
      effectiveSlots,
      pressure,
      reason: "Exclusive job requires all slots to be vacant",
    };
  }

  // 2. Heavy job quota
  if (job.resourceClass === "heavy") {
    const activeHeavy = activeJobs.filter((j) => j.resourceClass === "heavy").length;
    if (activeHeavy >= policy.maxHeavyJobs) {
      return {
        admitted: false,
        effectiveSlots,
        pressure,
        reason: `Heavy job quota reached (${activeHeavy}/${policy.maxHeavyJobs})`,
      };
    }
  }

  // 3. Project quota check
  const activeForProject = activeJobs.filter((j) => j.projectId === job.projectId).length;
  if (activeForProject >= policy.perProjectQuota) {
    return {
      admitted: false,
      effectiveSlots,
      pressure,
      reason: `Project quota reached for '${job.projectId}' (${activeForProject}/${policy.perProjectQuota})`,
    };
  }

  // 4. Overall effective capacity check
  // Note: running jobs are never killed if activeJobs.length > effectiveSlots (e.g. after capacity contraction).
  if (activeJobs.length >= effectiveSlots) {
    return {
      admitted: false,
      effectiveSlots,
      pressure,
      reason: `Effective slot capacity reached (${activeJobs.length}/${effectiveSlots})`,
    };
  }

  return {
    admitted: true,
    effectiveSlots,
    pressure,
  };
}

/**
 * Calculates priority score for fair scheduling.
 * Higher score gets scheduled first.
 */
export function calculateJobSchedulingScore(
  job: ScheduledJobRequest,
  activeJobs: ScheduledJobRequest[],
  now: number = Date.now()
): number {
  const baseWeight = PRIORITY_BASE_WEIGHTS[job.priority] ?? PRIORITY_BASE_WEIGHTS.normal;
  // Aging: 10 points per second spent in queue to prevent starvation
  const ageSeconds = Math.max(0, (now - job.createdAt) / 1000);
  const agingScore = Math.floor(ageSeconds * 10);

  // Fairness penalty: projects with more currently running jobs are deprioritized
  const activeForProject = activeJobs.filter((j) => j.projectId === job.projectId).length;
  const projectPenalty = activeForProject * 150;

  return baseWeight + agingScore - projectPenalty;
}

/**
 * Fair, priority-aware queue for multi-agent jobs.
 */
export class CliBridgePriorityQueue {
  private queue: ScheduledJobRequest[] = [];

  constructor(public readonly policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY) {}

  public enqueue(job: ScheduledJobRequest): void {
    if (!this.queue.some((j) => j.jobId === job.jobId)) {
      this.queue.push(job);
    }
  }

  public remove(jobId: string): boolean {
    const idx = this.queue.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  public size(): number {
    return this.queue.length;
  }

  public getQueue(): readonly ScheduledJobRequest[] {
    return [...this.queue];
  }

  /**
   * Finds and removes the highest-scoring job that satisfies current admission criteria.
   */
  public dequeueNextEligible(
    activeJobs: ScheduledJobRequest[],
    effectiveSlots: number,
    pressure: ResourcePressureLevel = "none",
    now: number = Date.now()
  ): { job: ScheduledJobRequest; decision: AdmissionDecision } | null {
    if (this.queue.length === 0) return null;

    // Score all jobs in queue
    const scored = this.queue.map((job) => ({
      job,
      score: calculateJobSchedulingScore(job, activeJobs, now),
    }));

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Find the first job that meets admission constraints
    for (const item of scored) {
      const decision = evaluateJobAdmission(
        item.job,
        activeJobs,
        effectiveSlots,
        pressure,
        this.policy
      );

      if (decision.admitted) {
        this.remove(item.job.jobId);
        return {
          job: item.job,
          decision,
        };
      }
    }

    return null;
  }
}
