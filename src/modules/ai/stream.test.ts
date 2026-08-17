import { beforeEach, describe, expect, it, vi } from "vitest";

// P4.x live progress. What is asserted here is not "does a stream exist" but
// the property the stream is only allowed to have: every event corresponds to
// something that actually happened, in the order it happened, and turning
// streaming on changes nothing else about the run.
//
// The model and the database are the only things faked. The loop, the caps, the
// verification pass and the audit write are the real ones — a test that stubbed
// those would be asserting the shape of a mock.

// Hoisted so it runs before config/env.ts is imported and parsed: ask() refuses
// to start without a key, and the point of these tests is the loop, not the
// guard (which failureReason.test.ts and the route's own 503 cover).
const { anthropicCalls, script, timeline, db } = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-not-used-a-request-is-never-made";
  return {
    anthropicCalls: [] as unknown[],
    script: [] as Array<{ content: unknown[]; stop_reason: string | null }>,
    timeline: [] as string[],
    db: {
      runUpdates: [] as Array<Record<string, unknown>>,
      toolCallRows: [] as Array<Record<string, unknown>>,
      messageRows: [] as Array<Record<string, unknown>>,
      auditRows: [] as Array<Record<string, unknown>>,
    },
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      create: async (params: unknown) => {
        anthropicCalls.push(params);
        const next = script.shift();
        if (!next) throw new Error("the fake model was called more times than the test scripted");
        return {
          ...next,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
        };
      },
    };
  },
}));

vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    agentConversation: {
      findFirst: async () => null,
      create: async () => ({ id: "convo_1" }),
      update: async () => ({}),
    },
    agentMessage: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.messageRows.push(data);
        return data;
      },
    },
    agentRun: {
      create: async () => ({ id: "run_1" }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        db.runUpdates.push(data);
        return data;
      },
    },
    agentToolCall: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.toolCallRows.push(data);
        return data;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.auditRows.push(data);
        return data;
      },
    },
  },
}));

// executeTool is faked, TOOLS is not: the labels asserted below are the real
// registry's, so a tool renamed without its label being updated fails here.
vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (_ctx: unknown, name: string) => {
      timeline.push(`ran:${name}`);
      const known = actual.TOOLS_BY_NAME.has(name);
      return {
        ok: known,
        result: known
          ? { data: { netRevenuePaise: "1245000", netRevenueRupees: "₹12,45,000" }, evidenceRef: "/evidence/revenue" }
          : { error: `No tool named "${name}".` },
        // Fixed rather than measured, so the equivalence test below compares
        // two runs that differ only in whether anyone was listening.
        durationMs: 7,
      };
    },
  };
});

// Imported after the mocks by vitest's hoisting, so the orchestrator under test
// is wired to the fake model and the fake database.
const { ask } = await import("./orchestrator.js");
type Event = import("./orchestrator.js").AskEvent;

const CTX = { organizationId: "org_1", timeZone: "Asia/Kolkata", userId: "user_1" };

const ANSWER = JSON.stringify({
  directAnswer: "Net revenue was ₹12,45,000.",
  keyFigures: [{ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" }],
  drivers: ["Order volume held"],
  evidence: ["/evidence/revenue"],
  dataStatus: "reconciled",
  warnings: [],
  recommendedAction: null,
});

const toolTurn = (...names: string[]) => ({
  content: names.map((name, i) => ({ type: "tool_use", id: `tu_${i}`, name, input: {} })),
  stop_reason: "tool_use" as const,
});
const answerTurn = (text = ANSWER) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" as const });

/** Collect events, and put them on the same timeline the tool runs are on. */
function sink(): { events: Event[]; send: (e: Event) => void } {
  const events: Event[] = [];
  return {
    events,
    send: (e) => {
      timeline.push(e.type === "tool" ? `event:tool:${e.name}` : `event:${e.type}`);
      events.push(e);
    },
  };
}

beforeEach(() => {
  anthropicCalls.length = 0;
  script.length = 0;
  timeline.length = 0;
  db.runUpdates.length = 0;
  db.toolCallRows.length = 0;
  db.messageRows.length = 0;
  db.auditRows.length = 0;
});

describe("streamed event sequence", () => {
  it("reports the stages and every tool that actually ran, in order", async () => {
    script.push(toolTurn("get_revenue_summary", "get_data_freshness"), answerTurn());
    const s = sink();

    const result = await ask(CTX, "how much did we make in july", undefined, s.send);

    expect(result.status).toBe("COMPLETED");
    expect(s.events.map((e) => (e.type === "tool" ? `tool:${e.name}` : `${e.type}:${"stage" in e ? e.stage : ""}`))).toEqual([
      "stage:resolving",
      "tool:get_revenue_summary",
      "tool:get_data_freshness",
      "stage:writing",
      "done:",
    ]);
  });

  it("emits a tool event only after that tool returned", async () => {
    // The property that separates a progress ticker from an animation: the
    // founder is never shown a step for work that has not happened. Both the
    // tool execution and the emit write to one timeline, so an emit that moved
    // ahead of its work would reorder this list.
    script.push(toolTurn("get_revenue_summary"), toolTurn("get_data_freshness"), answerTurn());
    const s = sink();

    await ask(CTX, "and how fresh is that", undefined, s.send);

    expect(timeline).toEqual([
      "event:stage",
      "ran:get_revenue_summary",
      "event:tool:get_revenue_summary",
      "ran:get_data_freshness",
      "event:tool:get_data_freshness",
      "event:stage",
      "event:done",
    ]);
  });

  it("carries the tool's own label and its measured duration", async () => {
    script.push(toolTurn("get_revenue_summary"), answerTurn());
    const s = sink();

    await ask(CTX, "revenue please", undefined, s.send);

    const event = s.events.find((e) => e.type === "tool");
    // The label comes from tools.ts, not from this test's imagination — it is
    // read out of the real registry.
    expect(event).toEqual({
      type: "tool",
      name: "get_revenue_summary",
      label: "Pulling revenue summaries",
      ok: true,
      durationMs: 7,
    });
  });

  it("reports a tool that failed rather than hiding it", async () => {
    // A model can name a tool that does not exist. That is a real event with a
    // real outcome, and a ticker showing only successes would be describing a
    // run that did not happen.
    script.push(toolTurn("get_unicorn_count"), answerTurn());
    const s = sink();

    await ask(CTX, "how many unicorns", undefined, s.send);

    const event = s.events.find((e) => e.type === "tool");
    expect(event).toMatchObject({ name: "get_unicorn_count", ok: false });
    // No label is invented for a tool that does not exist.
    expect(event && "label" in event && event.label).toBeNull();
  });

  it("hands the client the same AskResult the non-streaming route returns", async () => {
    script.push(toolTurn("get_revenue_summary"), answerTurn());
    const s = sink();

    const result = await ask(CTX, "revenue please", undefined, s.send);

    const done = s.events.at(-1);
    expect(done?.type).toBe("done");
    expect(done && "result" in done && done.result).toEqual(result);
  });

  it("closes an exhausted run with done, not silence", async () => {
    // MAX_TURNS is 8. A model that never stops calling tools must still produce
    // one terminal event, or a streaming client waits forever.
    for (let i = 0; i < 12; i += 1) script.push(toolTurn("get_revenue_summary"));
    const s = sink();

    const result = await ask(CTX, "loop forever", undefined, s.send);

    expect(result.status).toBe("EXHAUSTED");
    expect(result.turns).toBe(8);
    expect(s.events.filter((e) => e.type === "tool")).toHaveLength(8);
    expect(s.events.at(-1)).toEqual({ type: "done", result });
    // The cap is the orchestrator's, not the stream's: it stopped calling the
    // model after 8 turns whether or not anyone was watching.
    expect(anthropicCalls).toHaveLength(8);
    expect(db.runUpdates.at(-1)).toMatchObject({ status: "EXHAUSTED", turns: 8 });
  });

  it("closes a failed run with done carrying the failure, never a silent hang", async () => {
    script.push(answerTurn("this is prose, not the contract"));
    const s = sink();

    const result = await ask(CTX, "say something unparseable", undefined, s.send);

    expect(result.status).toBe("FAILED");
    expect(s.events.at(-1)).toEqual({ type: "done", result });
  });
});

describe("client disconnect", () => {
  it("stops the run and closes the AgentRun row rather than leaving it RUNNING", async () => {
    // The failure this prevents: a founder closes the tab, the loop keeps
    // spending tokens, and the row stays RUNNING forever with nothing to say
    // what became of it.
    script.push(toolTurn("get_revenue_summary", "get_data_freshness"), answerTurn());

    const result = await ask(CTX, "revenue please", undefined, (event) => {
      timeline.push(event.type === "tool" ? `event:tool:${event.name}` : `event:${event.type}`);
      if (event.type === "tool") throw new Error("The client disconnected before the answer was finished.");
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("disconnected");
    // Closed out, with the reason, and not left open.
    const final = db.runUpdates.at(-1);
    expect(final).toMatchObject({ status: "FAILED" });
    expect(final?.finishedAt).toBeInstanceOf(Date);
    expect(db.runUpdates.some((u) => u.status === "RUNNING")).toBe(false);
  });

  it("stops the loop at the disconnect instead of finishing the turn", async () => {
    script.push(toolTurn("get_revenue_summary", "get_data_freshness"), answerTurn());

    await ask(CTX, "revenue please", undefined, (event) => {
      timeline.push(event.type === "tool" ? `event:tool:${event.name}` : `event:${event.type}`);
      if (event.type === "tool") throw new Error("gone");
    });

    // The second tool of the turn was never run, and the model was never asked
    // for another turn. The trailing `done` is the run closing itself out —
    // the real route's sink throws for it too and writes nothing, but the run
    // always ends with a terminal event rather than trailing off.
    expect(timeline).toEqual([
      "event:stage",
      "ran:get_revenue_summary",
      "event:tool:get_revenue_summary",
      "event:done",
    ]);
    expect(anthropicCalls).toHaveLength(1);
    // The call that DID happen is still on the record — the audit trail does
    // not lose a tool call because the listener went away after it ran.
    expect(db.toolCallRows).toHaveLength(1);
    expect(db.toolCallRows[0]).toMatchObject({ toolName: "get_revenue_summary" });
  });

  it("does not turn a finished run into a failed one when the listener dies last", async () => {
    // The disconnect can land on the final event. The work is done and stored
    // by then; re-marking it FAILED would contradict the answer already given.
    script.push(toolTurn("get_revenue_summary"), answerTurn());

    const result = await ask(CTX, "revenue please", undefined, (event) => {
      if (event.type === "done") throw new Error("gone");
    });

    expect(result.status).toBe("COMPLETED");
    expect(db.runUpdates.at(-1)).toMatchObject({ status: "COMPLETED" });
  });
});

describe("onEvent absent", () => {
  // Streaming must be additive. If the listener changes what the run does, the
  // two routes have quietly become two products.
  const scenario = () => [toolTurn("get_revenue_summary", "get_data_freshness"), answerTurn()];

  // Dates are the only legitimate difference between two runs of the same
  // scenario, and they are wall-clock, not behaviour.
  //
  // `this[key]`, NOT the `value` argument. JSON.stringify calls a Date's own
  // toJSON() BEFORE handing the result to the replacer, so `value instanceof
  // Date` is never true and the obvious version of this helper normalises
  // nothing at all — it compared raw ISO strings and passed only when both runs
  // landed on the same millisecond. Measured at roughly one failure in twelve
  // full-suite runs. `this` is the holder object, and `this[key]` is the value
  // before toJSON touched it. The same trap is documented in
  // lib/orgReadCache.ts, which hit it first.
  const stable = (v: unknown) =>
    JSON.stringify(v, function (this: Record<string, unknown>, key: string, value: unknown) {
      return this[key] instanceof Date ? "<date>" : value;
    });

  it("produces an identical AskResult, identical writes and identical model calls", async () => {
    script.push(...scenario());
    const withSink = await ask(CTX, "how much did we make in july", undefined, sink().send);
    const streamed = {
      result: withSink,
      runUpdates: [...db.runUpdates],
      toolCallRows: [...db.toolCallRows],
      messageRows: [...db.messageRows],
      auditRows: [...db.auditRows],
      modelCalls: [...anthropicCalls],
    };

    anthropicCalls.length = 0;
    db.runUpdates.length = 0;
    db.toolCallRows.length = 0;
    db.messageRows.length = 0;
    db.auditRows.length = 0;
    script.push(...scenario());

    const plain = await ask(CTX, "how much did we make in july");

    expect(stable(plain)).toEqual(stable(streamed.result));
    expect(stable(db.runUpdates)).toEqual(stable(streamed.runUpdates));
    expect(stable(db.toolCallRows)).toEqual(stable(streamed.toolCallRows));
    expect(stable(db.messageRows)).toEqual(stable(streamed.messageRows));
    expect(stable(db.auditRows)).toEqual(stable(streamed.auditRows));
    // Same prompts, same tool schemas, same cache breakpoints.
    expect(stable(anthropicCalls)).toEqual(stable(streamed.modelCalls));
  });

  it("still runs the verification pass and the audit write", async () => {
    // The guards are not something the streaming path added; they are there in
    // both, and this is the run with no listener at all.
    script.push(...scenario());

    const result = await ask(CTX, "how much did we make in july");

    expect(result.verification).toMatchObject({ ok: true });
    expect(result.verification!.figuresChecked).toBeGreaterThan(0);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0]).toMatchObject({ action: "ai.answered", actorType: "AI" });
  });
});
