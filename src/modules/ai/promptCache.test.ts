import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { moveCacheBreakpoint } from "./orchestrator.js";

// The API caps cache breakpoints at four. MAX_TURNS is 8, and the orchestrator
// calls moveCacheBreakpoint once per turn — so a helper that ADDS a breakpoint
// without removing the previous one does not degrade gracefully, it makes the
// fifth turn of a long question fail outright with a 400. That failure would
// only appear on the hardest questions, which are exactly the ones a founder
// asks when something is wrong. Hence a test for the invariant rather than for
// the happy path.

function countBreakpoints(messages: Anthropic.MessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) if ("cache_control" in block) n += 1;
  }
  return n;
}

function toolResultTurn(id: string): Anthropic.MessageParam[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "get_revenue_summary", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "{}" }] },
  ];
}

describe("moveCacheBreakpoint", () => {
  it("never exceeds one breakpoint, across more turns than MAX_TURNS allows", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "why did margin drop?" }];

    for (let turn = 1; turn <= 12; turn += 1) {
      messages.push(...toolResultTurn(`tu_${turn}`));
      moveCacheBreakpoint(messages);
      expect(countBreakpoints(messages), `after turn ${turn}`).toBe(1);
    }
  });

  it("puts the breakpoint on the newest tool result, not an older one", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "q" }];
    messages.push(...toolResultTurn("tu_1"));
    moveCacheBreakpoint(messages);
    messages.push(...toolResultTurn("tu_2"));
    moveCacheBreakpoint(messages);

    const last = messages[messages.length - 1]!;
    const block = (last.content as Anthropic.ContentBlockParam[])[0] as { tool_use_id?: string; cache_control?: unknown };
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    expect(block.tool_use_id).toBe("tu_2");
  });

  it("marks the LAST block when one turn returned several tool results", () => {
    // One turn can carry many tool calls — that is why MAX_TOOL_CALLS exists
    // separately from MAX_TURNS. The breakpoint has to land at the end of the
    // whole block list or the tail of the turn is not cached.
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "q" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "{}" },
          { type: "tool_result", tool_use_id: "b", content: "{}" },
          { type: "tool_result", tool_use_id: "c", content: "{}" },
        ],
      },
    ];
    moveCacheBreakpoint(messages);

    const blocks = messages[1]!.content as Array<{ tool_use_id: string; cache_control?: unknown }>;
    expect(blocks[2]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("is a no-op on the opening turn, where the question is a bare string", () => {
    // The first message is the question as a plain string, which cannot carry
    // a breakpoint. It must not throw — the static breakpoint on the system
    // block is already covering the expensive part at this point.
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "why did margin drop?" }];
    expect(() => moveCacheBreakpoint(messages)).not.toThrow();
    expect(countBreakpoints(messages)).toBe(0);
  });
});
