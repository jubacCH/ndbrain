import { describe, expect, it } from "vitest";
import { loadEmbeddingConfig } from "./config.js";

describe("loadEmbeddingConfig", () => {
  it("defaults to provider none with no other fields set", () => {
    expect(loadEmbeddingConfig({})).toEqual({ provider: "none" });
  });

  it("reads provider, baseUrl, model, apiKey and coerces dim to a number", () => {
    expect(
      loadEmbeddingConfig({
        NDBRAIN_EMBEDDING_PROVIDER: "openai",
        NDBRAIN_EMBEDDING_BASE_URL: "https://example.test/v1",
        NDBRAIN_EMBEDDING_MODEL: "text-embedding-3-small",
        NDBRAIN_EMBEDDING_API_KEY: "sk-test",
        NDBRAIN_EMBEDDING_DIM: "1536",
      }),
    ).toEqual({
      provider: "openai",
      baseUrl: "https://example.test/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      dim: 1536,
    });
  });

  it("falls back to none for an unrecognized provider value", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_PROVIDER: "bogus" })).toEqual({ provider: "none" });
  });

  it("reads the ollama provider", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_PROVIDER: "ollama" })).toEqual({ provider: "ollama" });
  });

  it("leaves dim undefined when NDBRAIN_EMBEDDING_DIM is malformed (NaN guard)", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_DIM: "abc" })).toEqual({ provider: "none" });
  });

  it("leaves dim undefined when NDBRAIN_EMBEDDING_DIM is zero", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_DIM: "0" })).toEqual({ provider: "none" });
  });

  it("leaves dim undefined when NDBRAIN_EMBEDDING_DIM is negative", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_DIM: "-5" })).toEqual({ provider: "none" });
  });

  it("sets dim when NDBRAIN_EMBEDDING_DIM is a valid positive integer", () => {
    expect(loadEmbeddingConfig({ NDBRAIN_EMBEDDING_DIM: "1536" })).toEqual({ provider: "none", dim: 1536 });
  });
});
