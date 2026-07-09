import { describe, expect, it } from "vitest";
import { isPathInScope, assertWritable, ScopeError, type Scope } from "./scope.js";

describe("Scope", () => {
  describe("isPathInScope", () => {
    it("empty namespace matches all paths", () => {
      const scope: Scope = { namespace: "", canWrite: false };
      expect(isPathInScope(scope, "")).toBe(true);
      expect(isPathInScope(scope, "a.md")).toBe(true);
      expect(isPathInScope(scope, "myai/x.md")).toBe(true);
      expect(isPathInScope(scope, "other/deep/file.md")).toBe(true);
    });

    it("namespace matches exact and prefixed paths", () => {
      const scope: Scope = { namespace: "myai/", canWrite: false };
      expect(isPathInScope(scope, "myai/")).toBe(true);
      expect(isPathInScope(scope, "myai/a.md")).toBe(true);
      expect(isPathInScope(scope, "myai/sub/b.md")).toBe(true);
    });

    it("namespace does not match different prefixes", () => {
      const scope: Scope = { namespace: "myai/", canWrite: false };
      expect(isPathInScope(scope, "other/x.md")).toBe(false);
      expect(isPathInScope(scope, "a.md")).toBe(false);
      expect(isPathInScope(scope, "myai")).toBe(false);
    });

    it("enforces case-sensitive matching (does not match MYAI/)", () => {
      const scope: Scope = { namespace: "myai/", canWrite: false };
      expect(isPathInScope(scope, "MYAI/x.md")).toBe(false);
      expect(isPathInScope(scope, "MyAI/x.md")).toBe(false);
    });
  });

  describe("assertWritable", () => {
    it("throws ScopeError when scope is read-only (canWrite=false)", () => {
      const scope: Scope = { namespace: "myai/", canWrite: false };
      expect(() => assertWritable(scope, "myai/a.md")).toThrow(ScopeError);
      expect(() => assertWritable(scope, "myai/a.md")).toThrow(/read.only|read-only|write/i);
    });

    it("throws ScopeError when path is out of scope", () => {
      const scope: Scope = { namespace: "myai/", canWrite: true };
      expect(() => assertWritable(scope, "other/x.md")).toThrow(ScopeError);
      expect(() => assertWritable(scope, "other/x.md")).toThrow(/scope|not.in.scope/i);
    });

    it("throws ScopeError when both read-only and out of scope", () => {
      const scope: Scope = { namespace: "myai/", canWrite: false };
      expect(() => assertWritable(scope, "other/x.md")).toThrow(ScopeError);
    });

    it("does not throw when in-scope and writable", () => {
      const scope: Scope = { namespace: "myai/", canWrite: true };
      expect(() => assertWritable(scope, "myai/a.md")).not.toThrow();
      expect(() => assertWritable(scope, "myai/sub/b.md")).not.toThrow();
    });

    it("does not throw for exact namespace match when writable", () => {
      const scope: Scope = { namespace: "myai/", canWrite: true };
      expect(() => assertWritable(scope, "myai/")).not.toThrow();
    });

    it("allows write to any path with empty namespace and canWrite=true", () => {
      const scope: Scope = { namespace: "", canWrite: true };
      expect(() => assertWritable(scope, "a.md")).not.toThrow();
      expect(() => assertWritable(scope, "myai/x.md")).not.toThrow();
      expect(() => assertWritable(scope, "other/deep/file.md")).not.toThrow();
    });

    it("throws when empty namespace but canWrite=false", () => {
      const scope: Scope = { namespace: "", canWrite: false };
      expect(() => assertWritable(scope, "a.md")).toThrow(ScopeError);
    });
  });
});
