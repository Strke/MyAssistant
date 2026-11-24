import { defineTool } from "@earendil-works/pi-coding-agent";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { RagStore } from "./types";

interface MemorySearchParams {
  query: string;
  topK?: number;
  conversationId?: string;
  since?: number;
}

export function createMemorySearchTool(store: RagStore, defaultTopK = 8) {
  return defineTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search the user's past chat history and stored memories. Use when the user refers to earlier conversations, preferences, or personal context.",
    parameters: obj({
      query: str({ description: "Natural-language query over past conversations." }),
      topK: opt(
        num({
          description: `Maximum number of results (default ${defaultTopK}).`,
          minimum: 1,
          maximum: 20,
        }),
      ),
      conversationId: opt(str({ description: "Only search within a specific conversation id." })),
      since: opt(
        num({
          description: "Only include memories at or after this Unix timestamp in milliseconds.",
          minimum: 0,
        }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as MemorySearchParams;
      const hits = await store.search(params.query, {
        topK: params.topK ?? defaultTopK,
        conversationId: params.conversationId,
        since: params.since,
      });

      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: "No matching memories found." }],
          details: { hits: 0 },
        };
      }

      const text = hits
        .map(
          (hit, index) =>
            `[${index + 1}] (${new Date(hit.createdAt).toISOString()})\n${hit.content}`,
        )
        .join("\n\n");

      return { content: [{ type: "text", text }], details: { hits: hits.length } };
    },
  });
}
