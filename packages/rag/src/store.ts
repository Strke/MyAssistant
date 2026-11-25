import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { chunkText } from "./chunk";
import type { Embedder } from "./embedder";
import type {
  ChatMessageRecord,
  MemoryHit,
  MemorySearchOptions,
  RagStore,
  RecentMessage,
} from "./types";

export interface OpenRagStoreOptions {
  dbPath: string;
  embedder: Embedder;
  maxChars?: number;
  overlap?: number;
}

interface ChunkRow {
  rowid: number;
  chunk_id: string;
  message_id: string;
  conversation_id: string;
  content: string;
  created_at: number;
}

interface VectorRow {
  rowid: number;
  distance: number;
}

const RRF_K = 60;

function toBlob(vector: number[]): Buffer {
  const array = Float32Array.from(vector);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function buildFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, "").trim())
    .filter((term) => term.length > 0);
  const longEnough = terms.filter((term) => Array.from(term).length >= 3);
  const chosen = longEnough.length > 0 ? longEnough : terms;
  return chosen.map((term) => `"${term}"`).join(" OR ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class SqliteRagStore implements RagStore {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;
  private readonly maxChars: number;
  private readonly overlap: number;

  constructor(options: OpenRagStoreOptions) {
    this.embedder = options.embedder;
    this.maxChars = options.maxChars ?? 800;
    this.overlap = options.overlap ?? 100;

    if (options.dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(options.dbPath)), { recursive: true, mode: 0o700 });
    }

    this.db = new Database(options.dbPath);
    if (options.dbPath !== ":memory:") {
      try {
        chmodSync(options.dbPath, 0o600);
      } catch {
        // Best-effort on filesystems that do not support chmod.
      }
    }
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.migrate();
  }

  async addMessage(record: ChatMessageRecord): Promise<void> {
    const createdAt = record.createdAt || Date.now();

    this.db
      .prepare(
        `INSERT INTO conversations(id, channel, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(record.conversationId, record.channel, createdAt, createdAt);

    const messageInfo = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, conversation_id, role, sender, channel, external_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.role,
        record.sender ?? null,
        record.channel,
        record.externalId ?? null,
        record.content,
        createdAt,
      );

    if (messageInfo.changes === 0) {
      return;
    }

    const pieces = chunkText(record.content, { maxChars: this.maxChars, overlap: this.overlap });
    if (pieces.length === 0) {
      return;
    }

    const embeddings = await this.embedder.embed(pieces);
    if (embeddings.length !== pieces.length) {
      throw new Error("Embedding count did not match chunk count.");
    }

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks(id, message_id, conversation_id, seq, content, created_at, vec_rowid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts(rowid, content, chunk_id) VALUES (?, ?, ?)",
    );
    const insertVector = this.db.prepare("INSERT INTO chunks_vec(embedding) VALUES (?)");

    const write = this.db.transaction(() => {
      pieces.forEach((content, index) => {
        const embedding = embeddings[index];
        if (!embedding) {
          return;
        }
        const vectorInfo = insertVector.run(toBlob(embedding));
        const chunkId = `${record.id}:${index}`;
        const chunkInfo = insertChunk.run(
          chunkId,
          record.id,
          record.conversationId,
          index,
          content,
          createdAt,
          Number(vectorInfo.lastInsertRowid),
        );
        insertFts.run(Number(chunkInfo.lastInsertRowid), content, chunkId);
      });
    });

    write();
  }

  hasMessage(channel: string, externalId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM messages WHERE channel = ? AND external_id = ? LIMIT 1")
      .get(channel, externalId) as { found: number } | undefined;
    return Boolean(row);
  }

  async recentMessages(conversationId: string, limit: number): Promise<RecentMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT id, role, sender, content, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(conversationId, Math.max(1, limit)) as Array<{
      id: string;
      role: string;
      sender: string | null;
      content: string;
      created_at: number;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      sender: row.sender ?? undefined,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const topK = Math.max(1, options.topK ?? 8);
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const candidateLimit = Math.max(topK * 5, 20);
    const [queryVector] = await this.embedder.embed([trimmed]);
    const vectorChunks = queryVector
      ? this.hydrateVectorChunks(this.searchVector(queryVector, candidateLimit), options)
      : [];
    const keywordChunks = this.searchKeyword(trimmed, candidateLimit, options);

    const merged = new Map<string, { row: ChunkRow; score: number }>();
    const accumulate = (rows: ChunkRow[]) => {
      rows.forEach((row, index) => {
        const contribution = 1 / (RRF_K + index + 1);
        const existing = merged.get(row.chunk_id);
        if (existing) {
          existing.score += contribution;
        } else {
          merged.set(row.chunk_id, { row, score: contribution });
        }
      });
    };
    accumulate(vectorChunks);
    accumulate(keywordChunks);

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row, score }) => ({
        chunkId: row.chunk_id,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        content: row.content,
        score,
        createdAt: row.created_at,
      }));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender TEXT,
        channel TEXT NOT NULL,
        external_id TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON messages(channel, external_id) WHERE external_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vec_rowid INTEGER UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_message ON chunks(message_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_conversation ON chunks(conversation_id, created_at);
    `);

    this.ensureDimensions();
    this.createKeywordIndex();
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.embedder.dimensions}])`,
    );
  }

  private ensureDimensions(): void {
    const row = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get("embedding_dimensions") as { value: string } | undefined;

    if (row && Number(row.value) !== this.embedder.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: database has ${row.value}, configured ${this.embedder.dimensions}. Use a new RAG_DB_PATH or reindex.`,
      );
    }

    if (!row) {
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?)")
        .run("embedding_dimensions", String(this.embedder.dimensions));
    }
  }

  private createKeywordIndex(): void {
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, chunk_id UNINDEXED, tokenize = 'trigram')",
      );
    } catch {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, chunk_id UNINDEXED)",
      );
    }
  }

  private searchVector(vector: number[], limit: number): VectorRow[] {
    return this.db
      .prepare(
        "SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(toBlob(vector), limit) as VectorRow[];
  }

  private hydrateVectorChunks(vectorRows: VectorRow[], options: MemorySearchOptions): ChunkRow[] {
    if (vectorRows.length === 0) {
      return [];
    }

    const rowids = vectorRows.map((row) => row.rowid);
    const placeholders = rowids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT vec_rowid AS rowid, id AS chunk_id, message_id, conversation_id, content, created_at
         FROM chunks
         WHERE vec_rowid IN (${placeholders})`,
      )
      .all(...rowids) as ChunkRow[];
    const byRowid = new Map(rows.map((row) => [row.rowid, row]));

    const result: ChunkRow[] = [];
    for (const vectorRow of vectorRows) {
      const chunk = byRowid.get(vectorRow.rowid);
      if (!chunk) {
        continue;
      }
      if (options.conversationId && chunk.conversation_id !== options.conversationId) {
        continue;
      }
      if (options.since !== undefined && chunk.created_at < options.since) {
        continue;
      }
      result.push(chunk);
    }
    return result;
  }

  private searchKeyword(query: string, limit: number, options: MemorySearchOptions): ChunkRow[] {
    if (Array.from(query).length >= 3) {
      const ftsRows = this.tryKeywordFts(query, limit, options);
      if (ftsRows) {
        return ftsRows;
      }
    }

    const filters: string[] = [];
    const params: Array<string | number> = [`%${escapeLike(query)}%`];
    if (options.conversationId) {
      filters.push("conversation_id = ?");
      params.push(options.conversationId);
    }
    if (options.since !== undefined) {
      filters.push("created_at >= ?");
      params.push(options.since);
    }
    params.push(limit);

    return this.db
      .prepare(
        `SELECT rowid, id AS chunk_id, message_id, conversation_id, content, created_at
         FROM chunks
         WHERE content LIKE ? ESCAPE '\\'
         ${filters.map((filter) => `AND ${filter}`).join(" ")}
         LIMIT ?`,
      )
      .all(...params) as ChunkRow[];
  }

  private tryKeywordFts(
    query: string,
    limit: number,
    options: MemorySearchOptions,
  ): ChunkRow[] | undefined {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return undefined;
    }

    const filters: string[] = [];
    const params: Array<string | number> = [ftsQuery];
    if (options.conversationId) {
      filters.push("c.conversation_id = ?");
      params.push(options.conversationId);
    }
    if (options.since !== undefined) {
      filters.push("c.created_at >= ?");
      params.push(options.since);
    }
    params.push(limit);

    try {
      return this.db
        .prepare(
          `SELECT c.rowid AS rowid, c.id AS chunk_id, c.message_id, c.conversation_id, c.content, c.created_at
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ?
           ${filters.map((filter) => `AND ${filter}`).join(" ")}
           ORDER BY bm25(chunks_fts)
           LIMIT ?`,
        )
        .all(...params) as ChunkRow[];
    } catch {
      return undefined;
    }
  }
}

export function openRagStore(options: OpenRagStoreOptions): SqliteRagStore {
  return new SqliteRagStore(options);
}
