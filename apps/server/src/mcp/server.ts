import type { FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "../db/database.js";
import type { NoteService } from "../notes/service.js";
import type { Vault } from "../vault/files.js";
import { VaultPathError } from "../vault/files.js";
import type { ApiKeyService } from "../keys/service.js";
import { ScopeError } from "../keys/scope.js";
import { logAccess } from "../audit/log.js";
import {
  EditAmbiguousError,
  EditTargetNotFoundError,
  NoteBusyError,
  NoteExistsError,
  NoteNotFoundError,
} from "../notes/errors.js";
import { NoteTools, type Caller } from "./tools.js";

export interface McpDeps {
  db: Database;
  notes: NoteService;
  vault: Vault;
  apiKeys: ApiKeyService;
}

/** JSON-Schema tool definitions exposed over MCP, one per `NoteTools` method (Plan 2 Task 7). */
const TOOL_DEFS: Tool[] = [
  {
    name: "search_notes",
    description: "Full-text search over notes. Always scoped to the caller's namespace.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "read_note",
    description: "Reads a note by path. Out-of-scope and missing paths both come back as not-found.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_notes",
    description: "Lists all vault paths visible to the caller, filtered to their namespace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "build_context",
    description: "Assembles a note together with its backlinks and related notes.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_note",
    description: "Creates or overwrites a note. Requires a writable scope covering the path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_note",
    description: "Find-and-replace edit: `find` must occur exactly once in the note.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
      },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "append_note",
    description: "Appends content to the end of a note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "move_note",
    description: "Moves/renames a note. Both `from` and `to` must be in a writable scope.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "delete_note",
    description: "Deletes a note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

/** Domain errors `NoteTools` throws on denial/failure — mapped to a clean MCP tool-error
 *  result (`isError: true`) instead of being allowed to crash the transport. Anything else
 *  is an unexpected fault and is rethrown, becoming a JSON-RPC-level error response. */
function isToolDomainError(err: unknown): err is Error {
  return (
    err instanceof ScopeError ||
    err instanceof VaultPathError ||
    err instanceof NoteNotFoundError ||
    err instanceof NoteExistsError ||
    err instanceof NoteBusyError ||
    err instanceof EditTargetNotFoundError ||
    err instanceof EditAmbiguousError
  );
}

async function dispatch(
  db: Database,
  tools: NoteTools,
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_notes":
      return tools.searchNotes(caller, args as { query: string; limit?: number });
    case "read_note":
      return tools.readNote(caller, args as { path: string });
    case "list_notes":
      return tools.listNotes(caller);
    case "build_context":
      return tools.buildContext(caller, args as { path: string });
    case "write_note":
      return tools.writeNote(caller, args as { path: string; content: string });
    case "edit_note":
      return tools.editNote(caller, args as { path: string; find: string; replace: string });
    case "append_note":
      return tools.appendNote(caller, args as { path: string; content: string });
    case "move_note":
      return tools.moveNote(caller, args as { from: string; to: string });
    case "delete_note":
      return tools.deleteNote(caller, args as { path: string });
    default:
      // Not one of NoteTools' own methods, so it never went through their per-call
      // logAccess — record the denied attempt here so an unknown-tool probe still
      // leaves an audit trail.
      logAccess(db, caller.keyId, name, null, false);
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Builds one MCP `Server` wired to a single caller's scoped `NoteTools`. A fresh server (and
 *  transport, see `createMcpHandler`) is built per HTTP request, so the Bearer key is
 *  re-validated on every call and no cross-request session state is needed. */
function buildMcpServerForCaller(deps: McpDeps, caller: Caller): Server {
  const tools = new NoteTools({ db: deps.db, notes: deps.notes, vault: deps.vault });
  const server = new Server({ name: "ndbrain", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(deps.db, tools, caller, name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      if (isToolDomainError(err)) {
        return { content: [{ type: "text" as const, text: err.message }], isError: true };
      }
      // Catch non-typed errors: log them server-side for debugging, but return a generic
      // error response to the agent. This prevents leaking internal details (SQLite errors,
      // filesystem paths, etc.) to the calling agent.
      console.error(`[MCP] Unexpected error in tool ${name}:`, err);
      return { content: [{ type: "text" as const, text: "internal error" }], isError: true };
    }
  });

  return server;
}

/**
 * Fastify handler mounted at `/mcp` (Streamable HTTP, stateless mode): authenticates the
 * `Authorization: Bearer <agent-key>` header into a `Caller` via `ApiKeyService.validate`
 * (401 on a missing/invalid key), then drives one request/response cycle against a
 * fresh, per-request MCP server + transport. Stateless mode (`sessionIdGenerator: undefined`)
 * means no initialize handshake or session id is required across calls — each HTTP request
 * is fully self-contained, matching how a Bearer-keyed tool call should behave.
 */
export function createMcpHandler(deps: McpDeps) {
  return async function handleMcp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const validated = bearer ? await deps.apiKeys.validate(bearer) : null;
    if (!validated) {
      // No caller identity to blame (missing/invalid/revoked/expired key), but the
      // attempt itself is the most security-relevant thing to log: a failed probe would
      // otherwise leave zero trace in access_log.
      logAccess(deps.db, null, "auth", null, false);
      reply.code(401).send({ error: { code: "unauthorized", message: "invalid or missing agent key" } });
      return;
    }
    const caller: Caller = { keyId: validated.keyId, name: validated.name, scope: validated.scope };

    const server = buildMcpServerForCaller(deps, caller);
    // enableJsonResponse: a plain JSON body response instead of SSE streaming — this is a
    // simple request/reply tool-call API, not a server-push scenario.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Hand raw req/res to the SDK transport ourselves; Fastify must not also try to send a
    // reply once we've taken over the raw response stream.
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      // After hijack(), Fastify can't send a reply. If server.connect() or
      // transport.handleRequest() fails, the client may hang until timeout.
      // Log the error for debugging and force-close the raw socket to fail fast.
      console.error("[MCP] Error in hijacked request handling:", err);
      reply.raw.destroy();
    }
  };
}
