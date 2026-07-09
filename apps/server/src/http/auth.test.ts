import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { AuthService } from "./auth.js";

describe("AuthService", () => {
  it("creates users and logs in with correct password only", async () => {
    const auth = new AuthService(openDatabase(":memory:"));
    expect(auth.hasUsers()).toBe(false);
    await auth.createUser("julian", "secret123");
    expect(auth.hasUsers()).toBe(true);
    expect(await auth.login("julian", "wrong")).toBeNull();
    const token = await auth.login("julian", "secret123");
    expect(token).toBeTruthy();
    expect(auth.validateSession(token!)).toMatchObject({ username: "julian" });
  });

  it("logout invalidates the session", async () => {
    const auth = new AuthService(openDatabase(":memory:"));
    await auth.createUser("julian", "secret123");
    const token = (await auth.login("julian", "secret123"))!;
    auth.logout(token);
    expect(auth.validateSession(token)).toBeNull();
  });
});
