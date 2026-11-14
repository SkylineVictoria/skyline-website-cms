import { describe, expect, it } from "vitest";
import { dependencyChain, LMS_MENU } from "./lmsConfig";
describe("LMS standalone navigation", () => {
  it("has exactly eight unique LMS pages", () => {
    expect(LMS_MENU).toHaveLength(8);
    expect(new Set(LMS_MENU.map(m => m.id)).size).toBe(8);
    expect(new Set(LMS_MENU.map(m => m.route)).size).toBe(8);
    expect(LMS_MENU.every(m => m.route.startsWith("/admin/lms"))).toBe(true);
  });
  it("keeps the course -> intake -> batch hierarchy on dependent pages", () => {
    expect(dependencyChain("intakes")).toEqual(["course"]);
    expect(dependencyChain("batches")).toEqual(["course", "intake"]);
    for (const area of ["unit-delivery", "timetable", "attendance", "assessments"] as const) {
      expect(dependencyChain(area).slice(0, 3)).toEqual(["course", "intake", "batch"]);
    }
  });
  it("never points LMS navigation at Master Data or HRMS", () => {
    expect(LMS_MENU.every(m => !/master|staff|employees|businesses/.test(m.route))).toBe(true);
  });
});
