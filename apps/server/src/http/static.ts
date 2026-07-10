import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Default location of the built web app, resolved relative to THIS file
 * rather than `process.cwd()` (which varies: `pnpm -F @ndbrain/server dev`
 * runs from the repo root, a packaged/systemd run could be invoked from
 * anywhere). Three directories up from `apps/server/{src,dist}/http/static.ts`
 * lands on `apps/server`'s parent (`apps`); `web/dist` from there is
 * `apps/web/dist` - the same relative depth whether this runs compiled
 * (`dist/http/static.js`) or from source (`src/http/static.ts`), and matches
 * the Docker image too: the whole monorepo is copied verbatim into `/app`
 * (see the repo `Dockerfile`), it isn't restructured, so `apps/server` and
 * `apps/web` stay siblings there as well.
 */
const DEFAULT_WEB_DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "dist");

/** Path prefixes owned by other handlers - the SPA fallback must never serve
 *  `index.html` for these, even though (as a `notFoundHandler`) it can only
 *  ever run for a request nothing else already matched. Kept as an explicit,
 *  belt-and-suspenders check rather than relying solely on route-matching
 *  order/priority. */
function isReservedPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/collab" || pathname.startsWith("/api/");
}

/**
 * Serves the built web app at `dir` (`apps/web/dist` by default) at `/`, with
 * an SPA fallback to `index.html` for any unmatched GET outside `/api`,
 * `/mcp` and `/collab` - so a client-side route (e.g. `/notes/some-id`)
 * resolves correctly on a hard refresh or deep link instead of 404ing.
 *
 * Verified against the installed `@fastify/static@9.3.0`: with its default
 * `wildcard: true`, it registers a single `GET/HEAD /*` route under `dir`
 * that (a) resolves `/` and directory paths to `index.html` itself (no extra
 * wiring needed for the plain "load the app" case), and (b) calls
 * `reply.callNotFound()` for any path with no matching file on disk (ENOENT) -
 * which is what routes a deep-linked SPA path into the `setNotFoundHandler`
 * below instead of a raw 404.
 *
 * Must be registered AFTER `registerRoutes`/the `/collab` upgrade wiring in
 * `buildServer`: Fastify/`find-my-way` always prefers a concrete route (e.g.
 * `/api/v1/notes`) over this wildcard regardless of registration order, but
 * registering it last keeps that intent explicit and keeps this as the
 * unambiguous fallback layer.
 *
 * A no-op (logs and returns) when `dir` doesn't exist: running the server
 * from source without first building the web app (`pnpm -F @ndbrain/web
 * build`) is a normal dev/test flow, not a fatal error - there's simply
 * nothing to serve, and the API/collab/mcp routes must still work.
 */
export function registerStatic(app: FastifyInstance, dir: string = DEFAULT_WEB_DIST_DIR): void {
  if (!existsSync(dir)) {
    console.log(`[ndbrain] web dist not found at ${dir}, skipping static file serving`);
    return;
  }
  app.register(fastifyStatic, { root: dir });
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?", 1)[0];
    if (req.method !== "GET" || isReservedPath(pathname)) {
      return reply.code(404).send({ error: { code: "not_found", message: "not found" } });
    }
    return reply.sendFile("index.html", dir);
  });
}
