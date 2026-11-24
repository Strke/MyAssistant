export interface EmbeddingOptions {
  provider: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
}

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class HashEmbedder implements Embedder {
  constructor(readonly dimensions: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

    for (let index = 0; index < normalized.length; index += 1) {
      const gram = normalized.slice(index, index + 3);
      const slot = fnv1a(gram) % this.dimensions;
      const sign = fnv1a(`sign:${gram}`) % 2 === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }
}

class OpenAiEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: EmbeddingOptions, apiKey: string) {
    this.apiKey = apiKey;
    this.dimensions = options.dimensions;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    if (!payload.data || payload.data.length !== texts.length) {
      throw new Error("Embedding response did not match the number of inputs.");
    }
    return payload.data.map((item) => item.embedding);
  }
}

export function createEmbedder(options: EmbeddingOptions): Embedder {
  if (options.provider === "hash") {
    return new HashEmbedder(options.dimensions);
  }
  if (options.provider === "openai") {
    if (!options.apiKey) {
      throw new Error(
        "RAG_EMBEDDING_API_KEY is required for the openai embedding provider. Set it, or use RAG_EMBEDDING_PROVIDER=hash for local development.",
      );
    }
    return new OpenAiEmbedder(options, options.apiKey);
  }
  throw new Error(`Unsupported embedding provider: ${options.provider}`);
}
