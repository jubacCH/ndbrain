import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider, isEmbeddingEnabled, isNoneProvider } from "./provider.js";
import type { EmbeddingConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEmbeddingProvider - openai", () => {
  it("posts to {baseUrl}/embeddings with model/input/auth and returns vectors in input order", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://example.test/v1/embeddings");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ model: "text-embedding-3-small", input: ["a", "b", "c"] });
      return new Response(
        JSON.stringify({
          // Deliberately returned out of request order to prove sorting-by-index works.
          data: [
            { embedding: [3, 3], index: 2 },
            { embedding: [1, 1], index: 0 },
            { embedding: [2, 2], index: 1 },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({
      provider: "openai",
      baseUrl: "https://example.test/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
    });

    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(provider.id).toBe("openai:text-embedding-3-small");
    expect(provider.dim).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("batches requests in chunks of 96 and preserves order across batches", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((_, i) => ({ embedding: [i], index: i })),
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({ provider: "openai", apiKey: "sk-test" });
    const vectors = await provider.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(150);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[100]).toEqual([4]); // second batch, local index 4
  });

  it("uses the default OpenAI base URL and model when not configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({ provider: "openai" });
    await provider.embed(["hi"]);
    expect(provider.id).toBe("openai:text-embedding-3-small");
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" })),
    );
    const provider = createEmbeddingProvider({ provider: "openai", apiKey: "bad" });
    await expect(provider.embed(["a"])).rejects.toThrow(/401/);
  });

  it("never logs the API key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const provider = createEmbeddingProvider({ provider: "openai", apiKey: "super-secret-key" });
    await provider.embed(["a"]);

    const loggedCalls = [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls].flat();
    expect(loggedCalls.join(" ")).not.toContain("super-secret-key");
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });
});

describe("createEmbeddingProvider - ollama", () => {
  it("posts to {baseUrl}/api/embeddings once per text and collects vectors in order", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://localhost:11434/api/embeddings");
      const body = JSON.parse(init.body as string) as { model: string; prompt: string };
      calls.push(body.prompt);
      const vector = body.prompt === "a" ? [1, 0] : [0, 1];
      return new Response(JSON.stringify({ embedding: vector }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text" });
    const vectors = await provider.embed(["a", "b"]);

    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(provider.id).toBe("ollama:nomic-embed-text");
    expect(provider.dim).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("uses a custom base URL when configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://ollama.internal:11434/api/embeddings");
      return new Response(JSON.stringify({ embedding: [0.5] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({ provider: "ollama", baseUrl: "http://ollama.internal:11434" });
    await provider.embed(["x"]);
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })),
    );
    const provider = createEmbeddingProvider({ provider: "ollama" });
    await expect(provider.embed(["a"])).rejects.toThrow(/500/);
  });

  it("limits concurrent embedding requests to a bounded level and preserves order", async () => {
    let maxConcurrency = 0;
    let currentConcurrency = 0;

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      currentConcurrency++;
      maxConcurrency = Math.max(maxConcurrency, currentConcurrency);

      // Simulate some processing time
      await new Promise((resolve) => setTimeout(resolve, 10));

      const body = JSON.parse(init.body as string) as { prompt: string };
      const index = parseInt(body.prompt.split("-")[1], 10);
      currentConcurrency--;

      return new Response(JSON.stringify({ embedding: [index] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEmbeddingProvider({ provider: "ollama" });
    const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
    const vectors = await provider.embed(texts);

    // Verify results are in input order
    expect(vectors).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(vectors[i]).toEqual([i]);
    }

    // Verify concurrency was bounded (expect max 4 concurrent requests)
    expect(maxConcurrency).toBeLessThanOrEqual(4);
    expect(maxConcurrency).toBeGreaterThan(0);
  });
});

describe("createEmbeddingProvider - none", () => {
  it("throws when embed is called and reports as disabled", async () => {
    const provider = createEmbeddingProvider({ provider: "none" });
    expect(provider.id).toBe("none");
    expect(provider.dim).toBe(0);
    await expect(provider.embed(["a"])).rejects.toThrow("no embedding provider configured");
    expect(isNoneProvider(provider)).toBe(true);
    expect(isEmbeddingEnabled(provider)).toBe(false);
  });

  it("is the default when no provider config field matches", () => {
    const cfg = {} as EmbeddingConfig;
    const provider = createEmbeddingProvider(cfg);
    expect(provider.id).toBe("none");
  });
});

describe("isEmbeddingEnabled", () => {
  it("reflects config provider value", () => {
    expect(isEmbeddingEnabled({ provider: "none" })).toBe(false);
    expect(isEmbeddingEnabled({ provider: "openai" })).toBe(true);
    expect(isEmbeddingEnabled({ provider: "ollama" })).toBe(true);
  });

  it("reflects provider instance id", () => {
    expect(isEmbeddingEnabled(createEmbeddingProvider({ provider: "openai" }))).toBe(true);
    expect(isEmbeddingEnabled(createEmbeddingProvider({ provider: "none" }))).toBe(false);
  });
});
