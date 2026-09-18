import { describe, it, expect } from "vitest";
import {
  parseCronExpression,
  isValidCron,
  matchesCron,
  getNextCronTime,
  describeCron
} from "../src/core/daemon/cronParser.js";

describe("cronParser", () => {
  it("validates valid and invalid cron expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("0 0 1 JAN *")).toBe(true);
    expect(isValidCron("invalid cron")).toBe(false);
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("* 25 * * *")).toBe(false);
  });

  it("parses fields correctly with lists and steps", () => {
    const parsed = parseCronExpression("0,30 */2 1-5 * mon,fri");
    expect(parsed.minutes.has(0)).toBe(true);
    expect(parsed.minutes.has(30)).toBe(true);
    expect(parsed.minutes.has(15)).toBe(false);

    expect(parsed.hours.has(0)).toBe(true);
    expect(parsed.hours.has(2)).toBe(true);
    expect(parsed.hours.has(3)).toBe(false);

    expect(parsed.daysOfMonth.has(1)).toBe(true);
    expect(parsed.daysOfMonth.has(5)).toBe(true);
    expect(parsed.daysOfMonth.has(6)).toBe(false);

    expect(parsed.daysOfWeek.has(1)).toBe(true); // Monday
    expect(parsed.daysOfWeek.has(5)).toBe(true); // Friday
    expect(parsed.daysOfWeek.has(0)).toBe(false);
  });

  it("matches cron against specific Date objects", () => {
    // 2026-09-19 09:15:00 UTC, Saturday
    const date = new Date(Date.UTC(2026, 8, 19, 9, 15, 0));
    // Note: getMinutes/getHours in matchesCron use local time, so let's construct with local year/month/date
    const localDate = new Date(2026, 8, 19, 14, 30, 0); // local 14:30

    expect(matchesCron("30 14 * * *", localDate)).toBe(true);
    expect(matchesCron("0 14 * * *", localDate)).toBe(false);
    expect(matchesCron("*/15 * * * *", localDate)).toBe(true);
  });

  it("calculates getNextCronTime correctly", () => {
    const baseDate = new Date(2026, 8, 19, 10, 0, 0); // 10:00:00
    const nextEvery15 = getNextCronTime("*/15 * * * *", baseDate);

    expect(nextEvery15.getMinutes()).toBe(15);
    expect(nextEvery15.getHours()).toBe(10);

    const nextHourly = getNextCronTime("0 * * * *", baseDate);
    expect(nextHourly.getMinutes()).toBe(0);
    expect(nextHourly.getHours()).toBe(11);
  });

  it("produces human-readable descriptions", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 */3 * * *")).toBe("Every 3 hours");
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
  });
});
