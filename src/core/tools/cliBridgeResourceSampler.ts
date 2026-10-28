import os from "os";

export type ResourcePressureLevel = "none" | "moderate" | "high" | "critical";

export interface SystemResourceSample {
  timestamp: number;
  cpu: {
    cores: number;
    loadAverage1m: number;
    usagePercent: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    freePercent: number;
    processRssBytes: number;
  };
  pressure: ResourcePressureLevel;
  activeJobs: {
    light: number;
    normal: number;
    heavy: number;
    exclusive: number;
    total: number;
  };
}

let lastCpuSample: { idle: number; total: number } | null = null;

/**
 * Calculates CPU usage percentage across all cores since the last measurement.
 */
export function getCpuUsagePercent(): number {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += (cpu.times as any)[type];
    }
    totalIdle += cpu.times.idle;
  }

  if (!lastCpuSample) {
    lastCpuSample = { idle: totalIdle, total: totalTick };
    // First sample estimate: non-idle fraction of current ticks
    const initialUsage = totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0;
    return Math.min(100, Math.max(0, Math.round(initialUsage)));
  }

  const idleDelta = totalIdle - lastCpuSample.idle;
  const totalDelta = totalTick - lastCpuSample.total;
  lastCpuSample = { idle: totalIdle, total: totalTick };

  if (totalDelta <= 0) return 0;
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(usage)));
}

/**
 * Evaluates host resource pressure based on CPU usage and free memory percent.
 */
export function evaluateResourcePressure(
  cpuUsagePercent: number,
  freeMemPercent: number
): ResourcePressureLevel {
  if (freeMemPercent < 10 || cpuUsagePercent > 92) {
    return "critical";
  }
  if (freeMemPercent < 18 || cpuUsagePercent > 82) {
    return "high";
  }
  if (freeMemPercent < 28 || cpuUsagePercent > 70) {
    return "moderate";
  }
  return "none";
}

/**
 * Samples the host system resources and active job distribution.
 */
export function sampleSystemResources(activeJobCounts?: {
  light?: number;
  normal?: number;
  heavy?: number;
  exclusive?: number;
}): SystemResourceSample {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const freeMemPercent = totalMem > 0 ? Math.round((freeMem / totalMem) * 100) : 100;
  const cpuUsage = getCpuUsagePercent();
  const cores = os.cpus().length || 1;
  const loadAvg = os.loadavg ? os.loadavg()[0] || 0 : 0;
  const rss = process.memoryUsage ? process.memoryUsage().rss : 0;

  const light = activeJobCounts?.light || 0;
  const normal = activeJobCounts?.normal || 0;
  const heavy = activeJobCounts?.heavy || 0;
  const exclusive = activeJobCounts?.exclusive || 0;
  const total = light + normal + heavy + exclusive;

  const forcedPressure = process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE as ResourcePressureLevel | undefined;
  const pressure = (forcedPressure && ["none", "moderate", "high", "critical"].includes(forcedPressure))
    ? forcedPressure
    : evaluateResourcePressure(cpuUsage, freeMemPercent);

  return {
    timestamp: Date.now(),
    cpu: {
      cores,
      loadAverage1m: Math.round(loadAvg * 100) / 100,
      usagePercent: cpuUsage,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      freePercent: freeMemPercent,
      processRssBytes: rss,
    },
    pressure,
    activeJobs: {
      light,
      normal,
      heavy,
      exclusive,
      total,
    },
  };
}
