import { chunkNote } from "./chunk.js";
import { isNoneProvider } from "./provider.js";
import type { EmbeddingProvider } from "./provider.js";
import type { VectorStore } from "./store.js";

export interface EmbeddingIndexerOptions {
  /** Delay (ms) before the Nth retry after an embed failure; grows linearly with the attempt count, capped at `retryMaxDelayMs`. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Injectable scheduler, mainly so tests can use tiny real delays instead of the default `setTimeout`. */
  scheduler?: (fn: () => void, delayMs: number) => void;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Embeds notes asynchronously, without ever blocking the caller (a note write).
 *
 * Design:
 * - `enqueue` is synchronous and only touches in-memory state; the actual
 *   chunk → embed → store pipeline runs on an internal serial "pump" kicked off via a
 *   microtask. That means a burst of synchronous `enqueue` calls for the same path
 *   (e.g. rapid edits) coalesce onto the latest markdown before any embedding work
 *   starts — only the newest content for a path is ever embedded.
 * - Jobs are processed one path at a time (serial) to bound provider load; the Ollama
 *   provider additionally caps its own per-request concurrency.
 * - A failed embed (provider down, rate-limited, network blip, ...) is never thrown
 *   back at the caller: it's logged and the path is re-queued after a backoff delay,
 *   so a transient outage self-heals without operator intervention and without
 *   blocking unrelated paths (the failing path's retry is scheduled off to the side;
 *   the pump keeps draining the rest of the queue).
 * - Each path tracks a monotonic version number bumped on every `enqueue`. A scheduled
 *   retry only re-queues its (possibly stale) markdown if the path's version hasn't
 *   moved on since — otherwise a newer `enqueue` (or its own successful embed) has
 *   already superseded it, and blindly re-queueing would risk clobbering fresher
 *   content with stale content after a delay.
 */
export class EmbeddingIndexer {
  private readonly pending = new Map<string, string>();
  private readonly queueOrder: string[] = [];
  private readonly latestVersion = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly idleWaiters: Array<() => void> = [];

  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly scheduler: (fn: () => void, delayMs: number) => void;

  private pumping = false;
  private processingCount = 0;
  private pendingRetryTimers = 0;

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly store: VectorStore,
    options: EmbeddingIndexerOptions = {},
  ) {
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.scheduler = options.scheduler ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  }

  /** Non-blocking: schedules `path` for (re-)embedding. No-op when no embedding provider is configured. */
  enqueue(path: string, markdown: string): void {
    if (isNoneProvider(this.provider)) return;

    const version = (this.latestVersion.get(path) ?? 0) + 1;
    this.latestVersion.set(path, version);
    if (!this.pending.has(path)) this.queueOrder.push(path);
    this.pending.set(path, markdown);

    this.kickPump();
  }

  /** Deletes a note's vectors and drops any not-yet-started job for it (harmless if none exists). */
  removeNote(path: string): void {
    this.pending.delete(path);
    const queuedIndex = this.queueOrder.indexOf(path);
    if (queuedIndex !== -1) this.queueOrder.splice(queuedIndex, 1);
    this.retryAttempts.delete(path);
    // Also invalidates any in-flight retry's version check, so it won't resurrect
    // vectors for a note that was just deleted.
    this.latestVersion.delete(path);

    this.store.deleteNote(path);
  }

  /** Embeds an entire vault listing (e.g. on startup/CLI) and awaits completion. */
  async reindexAll(notes: Array<{ path: string; markdown: string }>): Promise<void> {
    for (const note of notes) this.enqueue(note.path, note.markdown);
    await this.flush();
  }

  /** Resolves once the queue is fully drained (nothing queued, in flight, or awaiting retry). For tests + graceful shutdown. */
  flush(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Count of outstanding jobs: queued + in flight + awaiting retry backoff. */
  size(): number {
    return this.queueOrder.length + this.processingCount + this.pendingRetryTimers;
  }

  private isIdle(): boolean {
    return this.queueOrder.length === 0 && this.processingCount === 0 && this.pendingRetryTimers === 0;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private kickPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.runPump().finally(() => {
        this.pumping = false;
        this.notifyIfIdle();
      });
    });
  }

  private async runPump(): Promise<void> {
    while (this.queueOrder.length > 0) {
      const path = this.queueOrder.shift() as string;
      const markdown = this.pending.get(path);
      this.pending.delete(path);
      if (markdown === undefined) continue;
      const version = this.latestVersion.get(path) as number;

      this.processingCount++;
      try {
        await this.embedAndStore(path, markdown);
        this.retryAttempts.delete(path);
      } catch (err) {
        this.scheduleRetry(path, markdown, version, err);
      } finally {
        this.processingCount--;
      }
    }
  }

  private async embedAndStore(path: string, markdown: string): Promise<void> {
    const chunks = chunkNote(markdown);
    const vectors = chunks.length > 0 ? await this.provider.embed(chunks.map((chunk) => chunk.text)) : [];
    this.store.upsertNote(
      path,
      chunks.map((chunk, i) => ({ ix: chunk.ix, vector: vectors[i] })),
    );
  }

  private scheduleRetry(path: string, markdown: string, version: number, err: unknown): void {
    const attempt = (this.retryAttempts.get(path) ?? 0) + 1;
    this.retryAttempts.set(path, attempt);
    const delayMs = Math.min(this.retryBaseDelayMs * attempt, this.retryMaxDelayMs);
    console.warn(
      `[ndbrain] embed indexer: embedding failed for "${path}" (attempt ${attempt}), retrying in ${delayMs}ms:`,
      err,
    );

    this.pendingRetryTimers++;
    this.scheduler(() => {
      this.pendingRetryTimers--;
      // Only re-queue if nothing newer has superseded this job in the meantime
      // (a fresh enqueue, or that fresh job's own successful embed).
      if (this.latestVersion.get(path) === version) {
        this.pending.set(path, markdown);
        this.queueOrder.push(path);
        this.kickPump();
      }
      this.notifyIfIdle();
    }, delayMs);
  }
}
