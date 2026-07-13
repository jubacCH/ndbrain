export type EmbeddingProviderKind = "openai" | "ollama" | "none";

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dim?: number;
}

function toProviderKind(value: string | undefined): EmbeddingProviderKind {
  if (value === "openai" || value === "ollama") return value;
  return "none";
}

/** Reads embedding provider settings from env. Separate from the app's main Config/loadConfig. */
export function loadEmbeddingConfig(env: NodeJS.ProcessEnv): EmbeddingConfig {
  const config: EmbeddingConfig = {
    provider: toProviderKind(env.NDBRAIN_EMBEDDING_PROVIDER),
  };
  if (env.NDBRAIN_EMBEDDING_BASE_URL) config.baseUrl = env.NDBRAIN_EMBEDDING_BASE_URL;
  if (env.NDBRAIN_EMBEDDING_MODEL) config.model = env.NDBRAIN_EMBEDDING_MODEL;
  if (env.NDBRAIN_EMBEDDING_API_KEY) config.apiKey = env.NDBRAIN_EMBEDDING_API_KEY;
  // Only set dim if the parsed value is a finite positive number. This prevents NaN
  // (from malformed input) from being treated as an explicit dimension, which would
  // lock the provider to NaN and cause confusing downstream failures.
  if (env.NDBRAIN_EMBEDDING_DIM) {
    const dim = Number(env.NDBRAIN_EMBEDDING_DIM);
    if (Number.isFinite(dim) && dim > 0) {
      config.dim = dim;
    }
  }
  return config;
}
