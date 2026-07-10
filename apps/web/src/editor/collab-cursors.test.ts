import { describe, expect, it } from "vitest";
import { agentActivityLabel, colorForName, peersFromAwarenessStates, type AwarenessStateLike } from "./collab-cursors";

describe("peersFromAwarenessStates", () => {
  it("maps a states Map into a peer list, reading name/color/agent from state.user", () => {
    const states = new Map<number, AwarenessStateLike>([
      [1, { user: { name: "Julian", color: "#5b7cfa" } }],
      [2, { user: { name: "MyAI", color: "#f59f00", agent: true } }],
    ]);

    expect(peersFromAwarenessStates(states)).toEqual([
      { clientId: 1, name: "Julian", color: "#5b7cfa", agent: false },
      { clientId: 2, name: "MyAI", color: "#f59f00", agent: true },
    ]);
  });

  it("excludes the local client id", () => {
    const states = new Map<number, AwarenessStateLike>([
      [1, { user: { name: "Julian", color: "#5b7cfa" } }],
      [2, { user: { name: "MyAI", color: "#f59f00", agent: true } }],
    ]);

    expect(peersFromAwarenessStates(states, 1)).toEqual([
      { clientId: 2, name: "MyAI", color: "#f59f00", agent: true },
    ]);
  });

  it("skips states with no user field (a peer that hasn't set one yet)", () => {
    const states = new Map<number, AwarenessStateLike>([[1, {}], [2, { user: { name: "MyAI" } }]]);

    expect(peersFromAwarenessStates(states)).toEqual([
      { clientId: 2, name: "MyAI", color: "#8b93a1", agent: false },
    ]);
  });

  it("defaults a missing name/color to placeholders", () => {
    const states = new Map<number, AwarenessStateLike>([[1, { user: {} }]]);

    expect(peersFromAwarenessStates(states)).toEqual([
      { clientId: 1, name: "Anonymous", color: "#8b93a1", agent: false },
    ]);
  });

  it("also accepts a plain iterable of entries (not just a Map)", () => {
    const entries: Array<[number, AwarenessStateLike]> = [[3, { user: { name: "Ada" } }]];

    expect(peersFromAwarenessStates(entries)).toEqual([
      { clientId: 3, name: "Ada", color: "#8b93a1", agent: false },
    ]);
  });
});

describe("agentActivityLabel", () => {
  it("returns null when no peer is an agent", () => {
    expect(agentActivityLabel([{ clientId: 1, name: "Julian", color: "#000", agent: false }])).toBeNull();
  });

  it("names the single agent peer", () => {
    expect(
      agentActivityLabel([
        { clientId: 1, name: "Julian", color: "#000", agent: false },
        { clientId: 2, name: "MyAI", color: "#f00", agent: true },
      ]),
    ).toBe("🤖 MyAI is editing…");
  });

  it("joins multiple agent peers with a plural verb", () => {
    expect(
      agentActivityLabel([
        { clientId: 2, name: "MyAI", color: "#f00", agent: true },
        { clientId: 3, name: "Scout", color: "#0f0", agent: true },
      ]),
    ).toBe("🤖 MyAI, Scout are editing…");
  });
});

describe("colorForName", () => {
  it("is deterministic for the same name", () => {
    expect(colorForName("julian")).toBe(colorForName("julian"));
  });

  it("returns a color from the fixed palette (a 6/8-digit hex string)", () => {
    expect(colorForName("julian")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("differentiates at least some distinct names", () => {
    const colors = new Set(["a", "b", "c", "d", "e", "f", "g"].map(colorForName));
    expect(colors.size).toBeGreaterThan(1);
  });
});
