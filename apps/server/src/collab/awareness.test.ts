import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  agentAwarenessClientId,
  agentAwarenessColor,
  clearAgentAwarenessState,
  setAgentAwarenessState,
} from "./awareness.js";

describe("agent awareness", () => {
  it("agentAwarenessClientId is deterministic per actor and never collides with a real (non-negative) Yjs client id", () => {
    expect(agentAwarenessClientId("myai")).toBe(agentAwarenessClientId("myai"));
    expect(agentAwarenessClientId("myai")).toBeLessThan(0);
    expect(agentAwarenessClientId("myai")).not.toBe(agentAwarenessClientId("other-agent"));
  });

  it("agentAwarenessColor is deterministic per actor", () => {
    expect(agentAwarenessColor("myai")).toBe(agentAwarenessColor("myai"));
    expect(agentAwarenessColor("myai")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("setAgentAwarenessState adds a { user: { name, agent: true, color } } entry visible via getStates()", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    setAgentAwarenessState(awareness, "myai");

    const clientId = agentAwarenessClientId("myai");
    const states = awareness.getStates();
    expect(states.get(clientId)).toEqual({
      user: { name: "myai", agent: true, color: agentAwarenessColor("myai") },
    });
  });

  it("broadcasts the change via the same 'update' event a real client's awareness update would fire", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const seen: unknown[] = [];
    awareness.on("update", (event: unknown) => seen.push(event));

    setAgentAwarenessState(awareness, "myai");

    expect(seen).toHaveLength(1);
    const clientId = agentAwarenessClientId("myai");
    expect(seen[0]).toEqual({ added: [clientId], updated: [], removed: [] });
  });

  it("re-setting the same actor's state emits an 'updated' (not 'added') change", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    setAgentAwarenessState(awareness, "myai");

    const seen: unknown[] = [];
    awareness.on("update", (event: unknown) => seen.push(event));
    setAgentAwarenessState(awareness, "myai");

    const clientId = agentAwarenessClientId("myai");
    expect(seen[0]).toEqual({ added: [], updated: [clientId], removed: [] });
  });

  it("clearAgentAwarenessState removes the entry", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    setAgentAwarenessState(awareness, "myai");
    const clientId = agentAwarenessClientId("myai");
    expect(awareness.getStates().has(clientId)).toBe(true);

    clearAgentAwarenessState(awareness, "myai");

    expect(awareness.getStates().has(clientId)).toBe(false);
  });

  it("two different actors get independent entries that can be cleared independently", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    setAgentAwarenessState(awareness, "myai");
    setAgentAwarenessState(awareness, "other-agent");

    clearAgentAwarenessState(awareness, "myai");

    expect(awareness.getStates().has(agentAwarenessClientId("myai"))).toBe(false);
    expect(awareness.getStates().has(agentAwarenessClientId("other-agent"))).toBe(true);
  });
});
