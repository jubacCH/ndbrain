import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@hocuspocus/provider` opens a real WebSocket on construction (via its bundled
// `HocuspocusProviderWebsocket`) - this test never wants a real socket, so the
// module is mocked and we assert `createCollabProvider` wires it up correctly
// (name/token/document/awareness) instead of exercising a live connection (that's
// the server E2E's job, see Task 10).
//
// `vi.mock` factories are hoisted above imports, so anything they reference
// must be created through `vi.hoisted` rather than a plain top-level `class`
// (which would still be in its temporal dead zone at hoist time).
const { providerCtorSpy, FakeHocuspocusProvider } = vi.hoisted(() => {
  const providerCtorSpy = vi.fn();

  class FakeAwareness {
    setLocalStateField = vi.fn();
    getStates = vi.fn(() => new Map());
    on = vi.fn();
    off = vi.fn();
  }

  class FakeHocuspocusProvider {
    document: unknown;
    awareness = new FakeAwareness();
    destroy = vi.fn();
    on = vi.fn();
    off = vi.fn();

    constructor(config: Record<string, unknown>) {
      providerCtorSpy(config);
      this.document = config.document;
    }
  }

  return { providerCtorSpy, FakeHocuspocusProvider };
});

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: FakeHocuspocusProvider,
}));

import { CONTENT_FIELD, createCollabProvider, deriveCollabWsUrl, normalizeNotePath } from "./collab";

describe("deriveCollabWsUrl", () => {
  it("uses wss:// when the page is served over https", () => {
    expect(deriveCollabWsUrl({ protocol: "https:", host: "notes.example.com" })).toBe(
      "wss://notes.example.com/collab",
    );
  });

  it("uses ws:// for plain http (dev server)", () => {
    expect(deriveCollabWsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/collab",
    );
  });
});

describe("normalizeNotePath", () => {
  it("passes an already-clean vault-relative path through unchanged", () => {
    expect(normalizeNotePath("myai/deploy.md")).toBe("myai/deploy.md");
  });

  it("strips a leading slash so the client never sends an absolute path", () => {
    expect(normalizeNotePath("/myai/deploy.md")).toBe("myai/deploy.md");
  });

  it("collapses duplicate slashes", () => {
    expect(normalizeNotePath("myai//deploy.md")).toBe("myai/deploy.md");
  });
});

describe("createCollabProvider", () => {
  beforeEach(() => {
    providerCtorSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects with the normalized path as name, the given token, and a fresh Y.Doc", () => {
    const handle = createCollabProvider({ path: "/myai/deploy.md", token: "tok123", wsUrl: "ws://x/collab" });

    expect(providerCtorSpy).toHaveBeenCalledTimes(1);
    const config = providerCtorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.url).toBe("ws://x/collab");
    expect(config.name).toBe("myai/deploy.md");
    expect(config.token).toBe("tok123");
    expect(config.document).toBe(handle.ydoc);
  });

  it("binds the 'content' Y.Text field", () => {
    const handle = createCollabProvider({ path: "a.md", token: null, wsUrl: "ws://x/collab" });

    expect(handle.ytext).toBe(handle.ydoc.getText(CONTENT_FIELD));
  });

  it("passes a null token through as an empty string (provider requires a string)", () => {
    createCollabProvider({ path: "a.md", token: null, wsUrl: "ws://x/collab" });

    const config = providerCtorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.token).toBe("");
  });

  it("destroy() tears down both the provider and the Y.Doc", () => {
    const handle = createCollabProvider({ path: "a.md", token: "t", wsUrl: "ws://x/collab" });
    const destroySpy = vi.spyOn(handle.ydoc, "destroy");

    handle.destroy();

    expect(handle.provider.destroy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("derives the ws URL from window.location when wsUrl is not given", () => {
    const original = window.location;
    // jsdom's `window.location` isn't directly assignable to a plain object
    // literal (its type is a branded `string & Location`); redefine the
    // property itself instead of assigning through it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, protocol: "https:", host: "notes.example.com" },
    });

    createCollabProvider({ path: "a.md", token: "t" });
    const config = providerCtorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.url).toBe("wss://notes.example.com/collab");

    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});
