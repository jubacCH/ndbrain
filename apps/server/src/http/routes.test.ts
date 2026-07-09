import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { buildServer } from "./server.js";

let dir: string;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-http-"));
  const db = openDatabase(":memory:");
  const vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  await auth.createUser("julian", "secret123");
  app = buildServer({ notes: new NoteService(vault, git, indexer), auth, db, git, indexer, vault });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "julian", password: "secret123" },
  });
  token = login.json().token;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const authed = (opts: object) => ({ ...opts, headers: { authorization: `Bearer ${token}` } });

describe("REST /api/v1", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notes" });
    expect(res.statusCode).toBe(401);
  });

  it("full note lifecycle: put, get, list, search, backlinks, history, delete", async () => {
    const put = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/myai/a.md", payload: { content: "# Alpha\n[[myai/b]]" } }),
    );
    expect(put.statusCode).toBe(204);
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/myai/b.md", payload: { content: "# Beta" } }));

    const get = await app.inject(authed({ method: "GET", url: "/api/v1/notes/myai/a.md" }));
    expect(get.json()).toMatchObject({ path: "myai/a.md", content: "# Alpha\n[[myai/b]]" });

    const list = await app.inject(authed({ method: "GET", url: "/api/v1/notes" }));
    expect(list.json().notes).toHaveLength(2);

    const search = await app.inject(authed({ method: "GET", url: "/api/v1/search?q=Alpha" }));
    expect(search.json().hits[0].path).toBe("myai/a.md");

    const back = await app.inject(authed({ method: "GET", url: "/api/v1/backlinks/myai/b.md" }));
    expect(back.json().backlinks).toEqual(["myai/a.md"]);

    const hist = await app.inject(authed({ method: "GET", url: "/api/v1/history/myai/a.md" }));
    expect(hist.json().history[0].author).toBe("julian");

    const del = await app.inject(authed({ method: "DELETE", url: "/api/v1/notes/myai/a.md" }));
    expect(del.statusCode).toBe(204);
  });

  it("maps unsafe paths to 400 and missing notes to 404", async () => {
    const bad = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/..%2Fevil.md", payload: { content: "x" } }),
    );
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject(authed({ method: "GET", url: "/api/v1/notes/nope.md" }));
    expect(missing.statusCode).toBe(404);
  });

  it("rejects writes into the .git directory with 400", async () => {
    const res = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/.git/x.md", payload: { content: "x" } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("moves a note via notes-move and preserves history", async () => {
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/src.md", payload: { content: "# Src" } }));
    const move = await app.inject(
      authed({ method: "POST", url: "/api/v1/notes-move", payload: { from: "src.md", to: "dst/moved.md" } }),
    );
    expect(move.statusCode).toBe(204);
    const gone = await app.inject(authed({ method: "GET", url: "/api/v1/notes/src.md" }));
    expect(gone.statusCode).toBe(404);
    const there = await app.inject(authed({ method: "GET", url: "/api/v1/notes/dst/moved.md" }));
    expect(there.json().content).toBe("# Src");
    const hist = await app.inject(authed({ method: "GET", url: "/api/v1/history/dst/moved.md" }));
    expect(hist.json().history.length).toBeGreaterThanOrEqual(2);
  });
});
