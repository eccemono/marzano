import { describe, expect, it } from "vitest";

import { assertSupportedNode } from "../src/runtime";

describe("assertSupportedNode", () => {
  it("accepts the pinned major", () => {
    expect(() => assertSupportedNode("22.23.2")).not.toThrow();
  });

  it("rejects the host system node major", () => {
    expect(() => assertSupportedNode("24.20.0")).toThrow(/requires Node 22/);
  });

  it("rejects an older major", () => {
    expect(() => assertSupportedNode("20.11.0")).toThrow(/requires Node 22/);
  });

  it("rejects an unparseable version", () => {
    expect(() => assertSupportedNode("not-a-version")).toThrow(/requires Node 22/);
  });
});
