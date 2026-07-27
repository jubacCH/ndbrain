/**
 * The MCP endpoint.
 *
 * Stateless Streamable HTTP: every request carries its own bearer key and gets a
 * fresh server instance. No session state means no session fixation, no cleanup
 * on disconnect, and no way for one client's context to reach another's — worth
 * more here than the round trip it costs, because this endpoint is meant to be
 * pointed at by clients we do not control.
 *
 * Implemented against the MCP protocol directly rather than through the SDK's
 * transport helpers: the SDK's HTTP transport wants to own the request lifecycle,
 * and this needs to sit inside the existing Fastify auth and error handling.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { App } from '../app.js';
import type { ApiKeyService } from '../auth/keys.js';
import { toProblem } from '../http/errors.js';
import { TOOLS, ToolRefusal, type ToolContext } from './tools.js';

/** The protocol version this server implements. */
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: string | number | null | undefined, value: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: string | number | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function registerMcpEndpoint(
  fastify: FastifyInstance,
  deps: { app: App; keys: ApiKeyService },
): void {
  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = deps.keys.resolve(secret);

    if (key === null) {
      // `WWW-Authenticate` so a compliant client knows *how* to authenticate
      // rather than just that it failed.
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="ndbrain"')
        .send(error(null, -32001, 'invalid or missing API key'));
    }

    const body = request.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (body === undefined || Array.isArray(body)) {
      // Batching is legal JSON-RPC but not part of what this endpoint promises;
      // saying so beats half-implementing it.
      return reply.code(400).send(error(null, -32600, 'expected a single JSON-RPC request'));
    }

    const context: ToolContext = { app: deps.app, keys: deps.keys, key };

    switch (body.method) {
      case 'initialize':
        return reply.send(
          result(body.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ndbrain', version: '0.1.0' },
            instructions:
              'Notes are Markdown files. Search before reading, and prefer append_note or ' +
              'edit_note over rewriting a note in full.',
          }),
        );

      case 'notifications/initialized':
        // A notification has no id and expects no response body.
        return reply.code(202).send();

      case 'ping':
        return reply.send(result(body.id, {}));

      case 'tools/list':
        return reply.send(
          result(body.id, {
            tools: TOOLS.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: {
                readOnlyHint: tool.readOnly,
                // Nothing here destroys data: delete is deliberately not exposed
                // over MCP, so an agent cannot lose a note in one call.
                destructiveHint: false,
              },
            })),
          }),
        );

      case 'tools/call': {
        const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
        const tool = TOOLS.find((candidate) => candidate.name === params.name);

        if (tool === undefined) {
          return reply.send(error(body.id, -32602, `unknown tool: ${String(params.name)}`));
        }

        try {
          const text = await tool.handler(
            context,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          return reply.send(result(body.id, { content: [{ type: 'text', text }] }));
        } catch (caught) {
          // A tool failure is a *result* in MCP, not a protocol error — the model
          // is supposed to read it and adjust. A deliberate refusal says exactly
          // why, since that is what the model has to work with. Anything else
          // goes through the same taxonomy the REST API uses, so an unexpected
          // error cannot leak a path or a driver message here either.
          let message: string;

          if (caught instanceof ToolRefusal) {
            message = caught.message;
          } else {
            const problem = toProblem(caught);
            message = problem.status === 500 ? 'internal error' : problem.message;

            if (problem.status === 500) {
              request.log.error({ err: caught, tool: tool.name }, 'mcp tool failed');
            }
          }

          return reply.send(
            result(body.id, { content: [{ type: 'text', text: message }], isError: true }),
          );
        }
      }

      default:
        return reply.send(error(body.id, -32601, `unknown method: ${body.method}`));
    }
  });

  // A GET on /mcp is how clients open a server-initiated event stream. This
  // server never initiates anything, so the honest answer is "not supported"
  // rather than an idle stream the client waits on forever.
  fastify.get('/mcp', async (_request, reply) =>
    reply.code(405).header('Allow', 'POST').send(error(null, -32601, 'this server does not stream')),
  );
}
