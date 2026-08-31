import { describe, expect, it } from "vitest";
import { decideStart } from "../../scripts/start.mjs";

describe("decideStart", () => {
  it("reuses a healthy recorded process", () => {
    expect(decideStart({ healthOk: true, pidAlive: true })).toEqual({
      action: "open-existing",
    });
  });

  it("starts a fresh process for stale runtime information", () => {
    expect(decideStart({ healthOk: false, pidAlive: true })).toEqual({
      action: "start-new",
    });
    expect(decideStart({ healthOk: false, pidAlive: false })).toEqual({
      action: "start-new",
    });
  });
});
