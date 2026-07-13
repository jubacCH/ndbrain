import type { EmbeddingConfig } from "./config.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
  readonly id: string;
}

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_BATCH_SIZE = 96;

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
const OLLAMA_DEFAULT_MODEL = "nomic-embed-text";

interface OpenAIEmbeddingItem {
  embedding: number[];
  index?: number;
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingItem[];
}

/** OpenAI-compatible embeddings provider (also works against local servers exposing the same API shape). */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly hasExplicitDim: boolean;
  private _dim: number;

  constructor(cfg: EmbeddingConfig) {
    this.baseUrl = cfg.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
    this.model = cfg.model ?? OPENAI_DEFAULT_MODEL;
    this.apiKey = cfg.apiKey;
    this.hasExplicitDim = cfg.dim !== undefined;
    this._dim = cfg.dim ?? 0;
    this.id = `openai:${this.model}`;
  }

  get dim(): number {
    return this._dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + OPENAI_BATCH_SIZE);
      results.push(...(await this.embedBatch(batch)));
    }
    if (!this.hasExplicitDim && results[0]) this._dim = results[0].length;
    return results;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: batch }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embedding request failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as OpenAIEmbeddingResponse;
    // The API returns items in request order, but each item also carries its own
    // `index`. Sort by it when present so a provider that reorders results (or a
    // partially-mocked test double) can never silently desync from the input order.
    const items = [...json.data];
    if (items.every((item) => item.index !== undefined)) {
      items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }
    return items.map((item) => item.embedding);
  }
}

/**
 * Ollama embeddings provider.
 *
 * API version assumption: targets the classic `POST /api/embeddings` endpoint
 * (`{model, prompt: string} -> {embedding: number[]}`), issuing one request per
 * input text. Newer Ollama releases additionally expose a batched
 * `POST /api/embed` (`{model, input: string[]} -> {embeddings: number[][]}`),
 * but the classic endpoint is supported by a wider range of installed Ollama
 * versions, so it was chosen for robustness. Revisit if batching throughput
 * becomes a bottleneck.
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly hasExplicitDim: boolean;
  private _dim: number;

  constructor(cfg: EmbeddingConfig) {
    this.baseUrl = cfg.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
    this.model = cfg.model ?? OLLAMA_DEFAULT_MODEL;
    this.hasExplicitDim = cfg.dim !== undefined;
    this._dim = cfg.dim ?? 0;
    this.id = `ollama:${this.model}`;
  }

  get dim(): number {
    return this._dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await Promise.all(texts.map((text) => this.embedOne(text)));
    if (!this.hasExplicitDim && vectors[0]) this._dim = vectors[0].length;
    return vectors;
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { embedding: number[] };
    return json.embedding;
  }
}

class NoneEmbeddingProvider implements EmbeddingProvider {
  readonly id = "none";
  readonly dim = 0;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error("no embedding provider configured");
  }
}

export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  switch (cfg.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(cfg);
    case "ollama":
      return new OllamaEmbeddingProvider(cfg);
    default:
      return new NoneEmbeddingProvider();
  }
}

export function isNoneProvider(provider: EmbeddingProvider): boolean {
  return provider.id === "none";
}

/** Accepts either an EmbeddingConfig or an already-constructed EmbeddingProvider. */
export function isEmbeddingEnabled(input: EmbeddingConfig | EmbeddingProvider): boolean {
  if ("provider" in input) return input.provider !== "none";
  return input.id !== "none";
}
