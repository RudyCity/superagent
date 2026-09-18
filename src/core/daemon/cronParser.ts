const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

interface FieldRule {
  allowed: Set<number>;
}

function parseCronField(field: string, min: number, max: number, nameMap?: Record<string, number>): Set<number> {
  const allowed = new Set<number>();
  const normalized = field.toLowerCase();

  // Split comma-separated parts
  const parts = normalized.split(",");
  for (const part of parts) {
    if (part === "*") {
      for (let i = min; i <= max; i++) allowed.add(i);
      continue;
    }

    // Step pattern: */n or range/n
    if (part.includes("/")) {
      const [rangePart, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid cron step "${stepStr}" in "${field}"`);
      }

      let start = min;
      let end = max;
      if (rangePart !== "*") {
        if (rangePart.includes("-")) {
          const [rStart, rEnd] = rangePart.split("-");
          start = resolveValue(rStart, min, max, nameMap);
          end = resolveValue(rEnd, min, max, nameMap);
        } else {
          start = resolveValue(rangePart, min, max, nameMap);
        }
      }

      for (let i = start; i <= end; i += step) {
        allowed.add(i);
      }
      continue;
    }

    // Range pattern: a-b
    if (part.includes("-")) {
      const [rStart, rEnd] = part.split("-");
      const start = resolveValue(rStart, min, max, nameMap);
      const end = resolveValue(rEnd, min, max, nameMap);
      if (start > end) {
        throw new Error(`Invalid range "${part}" in "${field}"`);
      }
      for (let i = start; i <= end; i++) {
        allowed.add(i);
      }
      continue;
    }

    // Single value
    const val = resolveValue(part, min, max, nameMap);
    allowed.add(val);
  }

  // Handle day-of-week 7 as 0 (Sunday)
  if (min === 0 && max === 7 && allowed.has(7)) {
    allowed.add(0);
    allowed.delete(7);
  }

  return allowed;
}

function resolveValue(valStr: string, min: number, max: number, nameMap?: Record<string, number>): number {
  if (nameMap && nameMap[valStr] !== undefined) {
    return nameMap[valStr];
  }
  const parsed = parseInt(valStr, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Value "${valStr}" is out of bounds [${min}-${max}]`);
  }
  return parsed;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`);
  }

  const [minField, hourField, domField, monthField, dowField] = fields;

  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const daysOfMonth = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12, MONTH_NAMES);
  const daysOfWeek = parseCronField(dowField, 0, 7, DAY_NAMES);

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function matchesCron(expression: string, date: Date = new Date()): boolean {
  try {
    const parsed = parseCronExpression(expression);
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dom = date.getDate();
    const month = date.getMonth() + 1; // 1-indexed
    const dow = date.getDay(); // 0 = Sunday

    if (!parsed.minutes.has(minute)) return false;
    if (!parsed.hours.has(hour)) return false;
    if (!parsed.daysOfMonth.has(dom)) return false;
    if (!parsed.months.has(month)) return false;
    if (!parsed.daysOfWeek.has(dow)) return false;

    return true;
  } catch {
    return false;
  }
}

export function getNextCronTime(expression: string, fromDate: Date = new Date()): Date {
  const parsed = parseCronExpression(expression);

  // Start from the next whole minute
  const current = new Date(fromDate.getTime());
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1);

  // Max search horizon: 5 years in minutes
  const maxMinutes = 5 * 365 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const minute = current.getMinutes();
    const hour = current.getHours();
    const dom = current.getDate();
    const month = current.getMonth() + 1;
    const dow = current.getDay();

    if (
      parsed.months.has(month) &&
      parsed.daysOfMonth.has(dom) &&
      parsed.daysOfWeek.has(dow) &&
      parsed.hours.has(hour) &&
      parsed.minutes.has(minute)
    ) {
      return current;
    }

    current.setMinutes(current.getMinutes() + 1);
  }

  throw new Error(`Unable to find next scheduled run for cron "${expression}" within search horizon.`);
}

export function describeCron(expression: string): string {
  try {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return expression;
    const [min, hour, dom, month, dow] = fields;

    if (expression === "* * * * *") return "Every minute";
    if (min.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
      return `Every ${min.substring(2)} minutes`;
    }
    if (min === "0" && hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") {
      return `Every ${hour.substring(2)} hours`;
    }
    if (min === "0" && !hour.includes("*") && dom === "*" && month === "*" && dow === "*") {
      return `Daily at ${hour.padStart(2, "0")}:00`;
    }
    return `Scheduled (${expression})`;
  } catch {
    return expression;
  }
}
