import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { deriveCollabWsUrl, getApiBaseUrl, getCollabWsUrl, getServerUrl, setServerUrl } from "./base-url";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getApiBaseUrl / getCollabWsUrl (browser - no regression)", () => {
  afterEach(() => {
    setTauriFlag(undefined);
    localStorage.clear();
  });

  it("returns '' outside Tauri, so client.ts requests stay relative/same-origin", () => {
    setTauriFlag(undefined);
    expect(getApiBaseUrl()).toBe("");
  });

  it("a client call hits the exact same relative /api/v1/... URL as before, with credentials:include", async () => {
    setTauriFlag(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { notes: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient().listNotes();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/notes");
    expect(init.credentials).toBe("include");

    vi.unstubAllGlobals();
  });

  it("derives the collab ws URL from window.location, matching deriveCollabWsUrl directly", () => {
    setTauriFlag(undefined);
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, protocol: "https:", host: "notes.example.com" },
    });

    expect(getCollabWsUrl("myai/a.md")).toBe(deriveCollabWsUrl(window.location));
    expect(getCollabWsUrl("myai/a.md")).toBe("wss://notes.example.com/collab");

    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});

describe("getApiBaseUrl / getCollabWsUrl (Tauri - configured server URL)", () => {
  beforeEach(() => {
    setTauriFlag(true);
    setServerUrl("https://brain.example");
  });

  afterEach(() => {
    setTauriFlag(undefined);
    localStorage.clear();
  });

  it("returns the configured origin", () => {
    expect(getApiBaseUrl()).toBe("https://brain.example");
  });

  it("a client call hits the absolute configured-origin URL", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { notes: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient().listNotes();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://brain.example/api/v1/notes");

    vi.unstubAllGlobals();
  });

  it("derives wss:// from an https:// server URL", () => {
    expect(getCollabWsUrl("myai/a.md")).toBe("wss://brain.example/collab");
  });

  it("derives ws:// from an http:// server URL", () => {
    setServerUrl("http://brain.example");
    expect(getCollabWsUrl("myai/a.md")).toBe("ws://brain.example/collab");
  });

  it("falls back to the location-derived ws URL when no server is configured", () => {
    localStorage.clear();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, protocol: "http:", host: "localhost:1420" },
    });

    expect(getServerUrl()).toBeNull();
    expect(getCollabWsUrl()).toBe("ws://localhost:1420/collab");

    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});

describe("setServerUrl / getServerUrl", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("strips a trailing slash before persisting", () => {
    setServerUrl("https://brain.example/");
    expect(getServerUrl()).toBe("https://brain.example");
  });

  it("round-trips a URL without a trailing slash unchanged", () => {
    setServerUrl("https://brain.example");
    expect(getServerUrl()).toBe("https://brain.example");
  });

  it("returns null when nothing has been configured yet", () => {
    expect(getServerUrl()).toBeNull();
  });
});
