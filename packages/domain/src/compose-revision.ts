import { composeRevisionSchema, type ComposeRevisionV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview } from "./compose-preview.js";

export class ComposeRevisionError extends Error {
  constructor(readonly code: "COMPOSE_REVISION_INVALID" | "COMPOSE_REVISION_CONFLICT" | "COMPOSE_PREVIEW_STALE") {
    super("Compose revision request is not eligible.");
    this.name = "ComposeRevisionError";
  }
}
export type CreateComposeRevisionInput = {
  document: string; projectId: string; composeId: string; revisionId: string; revisionNumber: number;
  createdBy: string; createdAt: string; expectedPreviewDigest: string;
};

/** The application supplies server identity/actor/time after normal authorization. */
export function createComposeRevision(input: CreateComposeRevisionInput, imagePolicy: ImageReferencePolicyV1): ComposeRevisionV1 {
  const preview = createComposePreview(input.document, input.projectId, imagePolicy);
  if (preview.configDigest !== input.expectedPreviewDigest) throw new ComposeRevisionError("COMPOSE_PREVIEW_STALE");
  const parsed = composeRevisionSchema.safeParse({ schemaVersion: 1, id: input.revisionId, projectId: input.projectId,
    composeId: input.composeId, number: input.revisionNumber, createdBy: input.createdBy, createdAt: input.createdAt, preview });
  if (!parsed.success) throw new ComposeRevisionError("COMPOSE_REVISION_INVALID");
  return parsed.data;
}

export type ComposeRevisionPageOptions = { limit: number; offset: number };
export type ComposeRevisionPage = ComposeRevisionPageOptions & { revisions: ComposeRevisionV1[]; total: number };
export type ComposeRevisionRepository = {
  /** Atomically append against the exact current revision; identical identity replay is read-only. */
  appendRevision(revision: ComposeRevisionV1, expectedRevisionId: string | null): Promise<ComposeRevisionV1>;
  findRevision(projectId: string, revisionId: string): Promise<ComposeRevisionV1 | null>;
  findLatestRevision(projectId: string, composeId: string): Promise<ComposeRevisionV1 | null>;
  listRevisions(projectId: string, composeId: string, options: ComposeRevisionPageOptions): Promise<ComposeRevisionPage>;
};

/** Reference adapter for source tests; runtime ownership and durable storage are separate boundaries. */
export class InMemoryComposeRevisionRepository implements ComposeRevisionRepository {
  readonly #revisions = new Map<string, ComposeRevisionV1>();
  readonly #latest = new Map<string, ComposeRevisionV1>();

  async appendRevision(revision: ComposeRevisionV1, expectedRevisionId: string | null): Promise<ComposeRevisionV1> {
    const parsed = composeRevisionSchema.safeParse(revision);
    if (!parsed.success || (expectedRevisionId !== null && (typeof expectedRevisionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(expectedRevisionId)))) {
      throw new ComposeRevisionError("COMPOSE_REVISION_INVALID");
    }
    const copy = parsed.data;
    const existing = this.#revisions.get(copy.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(copy)) throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
      return structuredClone(existing);
    }
    const current = this.#latest.get(copy.composeId);
    if ((current && current.projectId !== copy.projectId) || (current?.id ?? null) !== expectedRevisionId || copy.number !== (current?.number ?? 0) + 1) {
      throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
    }
    // No await/effect between validation and the two writes: one atomic memory turn.
    this.#revisions.set(copy.id, copy);
    this.#latest.set(copy.composeId, copy);
    return structuredClone(copy);
  }

  async findRevision(projectId: string, revisionId: string): Promise<ComposeRevisionV1 | null> {
    const revision = this.#revisions.get(revisionId);
    return revision?.projectId === projectId ? structuredClone(revision) : null;
  }

  async findLatestRevision(projectId: string, composeId: string): Promise<ComposeRevisionV1 | null> {
    const revision = this.#latest.get(composeId);
    return revision?.projectId === projectId ? structuredClone(revision) : null;
  }

  async listRevisions(projectId: string, composeId: string, options: ComposeRevisionPageOptions): Promise<ComposeRevisionPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
      || !Number.isInteger(options.offset) || options.offset < 0 || options.offset > 1_000_000) throw new ComposeRevisionError("COMPOSE_REVISION_INVALID");
    const revisions = [...this.#revisions.values()].filter((value) => value.projectId === projectId && value.composeId === composeId).sort((a, b) => b.number - a.number);
    return { revisions: structuredClone(revisions.slice(options.offset, options.offset + options.limit)), total: revisions.length, limit: options.limit, offset: options.offset };
  }
}
