import { describe, expect, test } from "bun:test";
import { namespaceContains, parseResourceNamespace } from "../src/host/plugin/namespace.ts";

describe("Resource namespace", () => {
  test("accepts opaque plugin paths, including existing persisted paths", () => {
    for (const path of ["v1", "v1/team-a", "v1/project/project-a", "v1/project/project-a/session/old-id"] as const) {
      expect(parseResourceNamespace(path)).toBe(path);
    }
  });
  test("rejects noncanonical and unsafe segments", () => {
    for (const path of ["v2", "v1/", "v1//a", "v1/../a", "v1/a/./b", "v1/a\\b", " v1"]) {
      expect(() => parseResourceNamespace(path)).toThrow("canonical");
    }
  });
  test("compares descendant paths at segment boundaries", () => {
    const parent = parseResourceNamespace("v1/team-a");
    const child = parseResourceNamespace("v1/team-a/research");
    expect(namespaceContains(parent, child)).toBe(true);
    expect(namespaceContains(child, parent)).toBe(false);
    expect(namespaceContains(parent, "v1/team-ab")).toBe(false);
  });
});
