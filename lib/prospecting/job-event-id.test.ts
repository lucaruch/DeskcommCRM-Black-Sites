import { describe, expect, it } from "vitest";
import { prospectingJobEventId } from "./job-event-id";

describe("prospectingJobEventId", () => {
  const recipient = "4647f3ba-c67c-4aef-b723-35feb1c99c4b";
  it("returns a stable PostgreSQL-compatible UUID v5", () => {
    const id = prospectingJobEventId(recipient, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(prospectingJobEventId(recipient, 0)).toBe(id);
  });
  it("separates recipients and follow-up steps", () => {
    const ids = [0, 1, 2].map(step => prospectingJobEventId(recipient, step));
    ids.push(prospectingJobEventId("5647f3ba-c67c-4aef-b723-35feb1c99c4b", 0));
    expect(new Set(ids).size).toBe(4);
  });
});
