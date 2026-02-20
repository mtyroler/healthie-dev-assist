/**
 * Real-life comparison: old dev-assist vs new code mode.
 *
 * Drives both MCP servers directly via JSON-RPC over stdio.
 * Simulates the exact sequence of tool calls an LLM would make for each task.
 * Measures actual response sizes and turn counts.
 *
 * Token estimation: tiktoken-compatible chars÷4 approximation, applied to
 * the FULL conversation context (what the LLM sees each turn), not just
 * the tool response.
 *
 * Run: npx tsx test/real-compare.ts
 */

import { McpClient, ToolResult } from "./mcp-client.js";
import { writeFileSync } from "fs";
import { resolve } from "path";

// ── Server configs ────────────────────────────────────────────────────────────

const OLD_SERVER = {
  name: "old dev-assist",
  command: "node",
  args: ["/Users/max.tyroler/scripts/healthie-dev-assist/mcp-with-search.js"],
};

const NEW_SERVER = {
  name: "new code mode",
  command: "npx",
  args: ["tsx", resolve(import.meta.dirname, "../src/server.ts")],
};

// ── System prompts (approximating what Claude Desktop sends) ──────────────────

// Old dev-assist has no MCP system prompt — tools are its only context
const OLD_SYSTEM_PROMPT = `You are a helpful assistant with access to tools for exploring the Healthie GraphQL API schema.`;

// New code mode provides TypeScript type defs as the system prompt
const NEW_SYSTEM_PROMPT = `You are a Healthie API expert. You have access to a healthie object:
declare const healthie: {
  search(query: string, options?: { kind?: 'type'|'field'|'query'|'mutation'; limit?: number }): Promise<SearchResult[]>;
  introspect(typeName: string): Promise<TypeDetails>;
  schema(): Promise<string>;
  query<T>(graphql: string, variables?: Record<string, unknown>): Promise<T>;
  mutate<T>(graphql: string, variables?: Record<string, unknown>): Promise<T>;
};`;

// Approximate tokens for tool definitions sent on every request
// Old: search_schema + introspect tool definitions (~400 tokens)
// New: execute_healthie_code tool definition (~250 tokens)
const OLD_TOOL_DEF_TOKENS = 400;
const NEW_TOOL_DEF_TOKENS = 250;

// ── Token accounting ──────────────────────────────────────────────────────────

function t(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Turn {
  inputTokens: number;  // everything the LLM sees going IN
  outputTokens: number; // what the LLM generates
  toolResult: ToolResult;
}

/**
 * Calculate the full input token count for a given turn.
 * The LLM re-reads the entire conversation history each turn.
 */
function calcInputTokens(
  systemPrompt: string,
  toolDefTokens: number,
  userQuestion: string,
  priorTurns: Turn[],
  currentToolCall: string // the LLM output that triggers this tool
): number {
  // System prompt + tool defs (constant overhead per turn)
  const base = t(systemPrompt) + toolDefTokens;

  // User question
  const questionTokens = t(userQuestion);

  // All prior turns (output + tool result) — grows each turn
  const historyTokens = priorTurns.reduce(
    (sum, turn) =>
      sum + turn.outputTokens + t(turn.toolResult.responseText),
    0
  );

  // The LLM's own output for this turn (tool call JSON)
  const thisOutputTokens = t(currentToolCall);

  return base + questionTokens + historyTokens + thisOutputTokens;
}

// Approximate what an LLM would output to call each old-style tool
function oldToolCallOutput(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: tool, arguments: args });
}

// Approximate what an LLM would output to call execute_healthie_code
function newToolCallOutput(code: string): string {
  return `I'll execute this code to find what you need:\n\`\`\`typescript\n${code}\n\`\`\``;
}

// ── Task definitions ──────────────────────────────────────────────────────────

interface Task {
  id: string;
  question: string;
  // Sequence of tool calls the old LLM would make (each waits for prior result)
  oldCalls: Array<{ tool: "search_schema"; args: Record<string, unknown> }>;
  // Single code execution for new approach
  newCode: string;
}

const TASKS: Task[] = [
  {
    id: "T1",
    question: "What fields are available on the Appointment type?",
    oldCalls: [
      { tool: "search_schema", args: { query: "Appointment", type: "type" } },
      { tool: "search_schema", args: { query: "type Appointment {", context_lines: 80 } },
    ],
    newCode: `
      const results = await healthie.search("Appointment", { kind: "type", limit: 5 });
      const appt = results.find(r => r.name === "Appointment");
      const details = await healthie.introspect(appt?.name ?? "Appointment");
      return details;
    `,
  },
  {
    id: "T2",
    question: "What mutations exist for creating appointments?",
    oldCalls: [
      { tool: "search_schema", args: { query: "appointment", type: "mutation" } },
      { tool: "search_schema", args: { query: "createAppointment" } },
    ],
    newCode: `
      const mutations = await healthie.search("appointment", { kind: "mutation" });
      const creates = mutations.filter(m => m.name.toLowerCase().includes("create"));
      return { all: mutations.map(m => m.name), creates: creates.map(m => ({ name: m.name, description: m.description })) };
    `,
  },
  {
    id: "T3",
    question: "Explore the User type and find related types in the schema.",
    oldCalls: [
      { tool: "search_schema", args: { query: "type User", type: "type" } },
      { tool: "search_schema", args: { query: "type User {", context_lines: 100 } },
      { tool: "search_schema", args: { query: "UserGroup", type: "type" } },
    ],
    newCode: `
      const [searchResults, userDetails, userGroupDetails] = await Promise.all([
        healthie.search("user", { kind: "type", limit: 10 }),
        healthie.introspect("User", { limit: 30 }),
        healthie.introspect("UserGroup"),
      ]);
      return { searchResults, userDetails, userGroupDetails };
    `,
  },
  {
    id: "T4",
    question: "Find all types related to billing and insurance.",
    oldCalls: [
      { tool: "search_schema", args: { query: "billing" } },
      { tool: "search_schema", args: { query: "insurance" } },
      { tool: "search_schema", args: { query: "payment" } },
    ],
    newCode: `
      const [billing, insurance, payment] = await Promise.all([
        healthie.search("billing", { limit: 15 }),
        healthie.search("insurance", { limit: 15 }),
        healthie.search("payment", { limit: 15 }),
      ]);
      return {
        billing: billing.map(r => ({ name: r.name, kind: r.kind })),
        insurance: insurance.map(r => ({ name: r.name, kind: r.kind })),
        payment: payment.map(r => ({ name: r.name, kind: r.kind })),
      };
    `,
  },
  {
    id: "T5",
    question: "What queries are available for working with appointments?",
    oldCalls: [
      { tool: "search_schema", args: { query: "appointment", type: "query" } },
    ],
    newCode: `
      const queries = await healthie.search("appointment", { kind: "query" });
      return queries.map(q => ({ name: q.name, description: q.description }));
    `,
  },
];

// ── Run a task against one server ─────────────────────────────────────────────

interface TaskRun {
  taskId: string;
  serverName: string;
  turns: Turn[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  success: boolean;
}

async function runOldTask(
  client: McpClient,
  task: Task
): Promise<TaskRun> {
  const turns: Turn[] = [];
  let totalDurationMs = 0;

  for (const call of task.oldCalls) {
    const toolCallOutput = oldToolCallOutput(call.tool, call.args);
    const inputTokens = calcInputTokens(
      OLD_SYSTEM_PROMPT,
      OLD_TOOL_DEF_TOKENS,
      task.question,
      turns,
      toolCallOutput
    );
    const outputTokens = t(toolCallOutput) + 50; // +50 for LLM preamble ("Let me search for...")

    const result = await client.callTool(call.tool, call.args);
    totalDurationMs += result.durationMs;

    turns.push({ inputTokens, outputTokens, toolResult: result });
  }

  // Final LLM response turn (synthesizes results into an answer)
  const finalAnswerTokens = 200; // approximate LLM summary
  const finalInputTokens = calcInputTokens(
    OLD_SYSTEM_PROMPT,
    OLD_TOOL_DEF_TOKENS,
    task.question,
    turns,
    "" // no tool call, just answer
  );
  // Add a synthetic "answer" turn
  turns.push({
    inputTokens: finalInputTokens,
    outputTokens: finalAnswerTokens,
    toolResult: {
      tool: "__answer__",
      args: {},
      responseText: "",
      responseBytes: 0,
      durationMs: 0,
      isError: false,
    },
  });

  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);

  return {
    taskId: task.id,
    serverName: OLD_SERVER.name,
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalDurationMs,
    success: turns.every((t) => !t.toolResult.isError),
  };
}

async function runNewTask(
  client: McpClient,
  task: Task
): Promise<TaskRun> {
  const toolCallOutput = newToolCallOutput(task.newCode);
  const inputTokens = calcInputTokens(
    NEW_SYSTEM_PROMPT,
    NEW_TOOL_DEF_TOKENS,
    task.question,
    [],
    toolCallOutput
  );
  const outputTokens = t(toolCallOutput) + 50;

  const result = await client.callTool("execute_healthie_code", {
    code: task.newCode,
  });

  // Final answer turn
  const finalAnswerTokens = 200;
  const finalInputTokens =
    t(NEW_SYSTEM_PROMPT) +
    NEW_TOOL_DEF_TOKENS +
    t(task.question) +
    outputTokens +
    t(result.responseText) +
    finalAnswerTokens;

  const turns: Turn[] = [
    {
      inputTokens,
      outputTokens,
      toolResult: result,
    },
    {
      inputTokens: finalInputTokens,
      outputTokens: finalAnswerTokens,
      toolResult: {
        tool: "__answer__",
        args: {},
        responseText: "",
        responseBytes: 0,
        durationMs: 0,
        isError: false,
      },
    },
  ];

  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);

  return {
    taskId: task.id,
    serverName: NEW_SERVER.name,
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalDurationMs: result.durationMs,
    success: !result.isError,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\nHealthie Dev Assist: Real-Life Token Comparison");
console.log("=".repeat(55));
console.log("Methodology: full conversation context per turn (not just I/O)");
console.log("Token estimate: chars÷4 per message, accumulated across turns\n");

// Start both servers
console.log("Starting servers...");
const oldClient = new McpClient(OLD_SERVER.command, OLD_SERVER.args);
const newClient = new McpClient(NEW_SERVER.command, NEW_SERVER.args);

await oldClient.initialize();
console.log("  ✓ old dev-assist");
await newClient.initialize();
console.log("  ✓ new code mode\n");

const results: Array<{ old: TaskRun; new: TaskRun }> = [];

for (const task of TASKS) {
  console.log(`${task.id}: ${task.question}`);

  const [oldRun, newRun] = await Promise.all([
    runOldTask(oldClient, task),
    runNewTask(newClient, task),
  ]);

  const tokRed = Math.round((1 - newRun.totalTokens / oldRun.totalTokens) * 100);
  const oldTurns = oldRun.turns.filter((t) => t.toolResult.tool !== "__answer__").length;
  const newTurns = 1;

  const speedup = oldRun.totalDurationMs > 0
    ? (oldRun.totalDurationMs / newRun.totalDurationMs).toFixed(1)
    : "n/a";
  console.log(
    `  Old: ${oldTurns} tool call(s), ${oldRun.totalTokens.toLocaleString()} tokens, ${oldRun.totalDurationMs}ms`
  );
  console.log(
    `  New: ${newTurns} tool call(s), ${newRun.totalTokens.toLocaleString()} tokens, ${newRun.totalDurationMs}ms`
  );
  console.log(`  → ${tokRed}% fewer tokens | ${oldTurns}x fewer tool calls | ${speedup}x faster\n`);

  results.push({ old: oldRun, new: newRun });
}

oldClient.close();
newClient.close();

// ── Summary table ─────────────────────────────────────────────────────────────

const totOld = results.reduce((s, r) => s + r.old.totalTokens, 0);
const totNew = results.reduce((s, r) => s + r.new.totalTokens, 0);
const totOldTurns = results.reduce(
  (s, r) => s + r.old.turns.filter((t) => t.toolResult.tool !== "__answer__").length, 0
);
const overallRed = Math.round((1 - totNew / totOld) * 100);
const overallTurnRed = Math.round((1 - results.length / totOldTurns) * 100);
const totOldMs = results.reduce((s, r) => s + r.old.totalDurationMs, 0);
const totNewMs = results.reduce((s, r) => s + r.new.totalDurationMs, 0);
const overallSpeedup = totNewMs > 0 ? (totOldMs / totNewMs).toFixed(1) : "n/a";

console.log("=".repeat(55));
console.log("SUMMARY");
console.log("=".repeat(55));
console.log(
  `${"Task".padEnd(5)} ${"Old ms".padEnd(9)} ${"New ms".padEnd(9)} ${"Speed".padEnd(8)} ${"Old tok".padEnd(10)} ${"New tok".padEnd(10)} Tokens`
);
console.log("-".repeat(62));

for (const { old: o, new: n } of results) {
  const red = Math.round((1 - n.totalTokens / o.totalTokens) * 100);
  const speedup = n.totalDurationMs > 0
    ? (o.totalDurationMs / n.totalDurationMs).toFixed(1) + "x"
    : "n/a";
  console.log(
    `${o.taskId.padEnd(5)} ${String(o.totalDurationMs).padEnd(9)} ${String(n.totalDurationMs).padEnd(9)} ${speedup.padEnd(8)} ${o.totalTokens.toLocaleString().padEnd(10)} ${n.totalTokens.toLocaleString().padEnd(10)} -${red}%`
  );
}

console.log("-".repeat(62));
console.log(
  `${"TOT".padEnd(5)} ${String(totOldMs).padEnd(9)} ${String(totNewMs).padEnd(9)} ${(overallSpeedup + "x").padEnd(8)} ${totOld.toLocaleString().padEnd(10)} ${totNew.toLocaleString().padEnd(10)} -${overallRed}%`
);
console.log(
  `\nOverall: -${overallRed}% tokens | -${overallTurnRed}% tool calls (${totOldTurns}→${results.length}) | ${overallSpeedup}x faster`
);

// ── Markdown report ───────────────────────────────────────────────────────────

const summaryRows = results.map(({ old: o, new: n }) => {
  const oldTurns = o.turns.filter((t) => t.toolResult.tool !== "__answer__").length;
  const red = Math.round((1 - n.totalTokens / o.totalTokens) * 100);
  const speedup = n.totalDurationMs > 0
    ? (o.totalDurationMs / n.totalDurationMs).toFixed(1) + "x"
    : "n/a";
  return `| ${o.taskId} | ${TASKS.find(t => t.id === o.taskId)!.question} | ${oldTurns} | 1 | ${o.totalDurationMs}ms | ${n.totalDurationMs}ms | ${speedup} | ${o.totalTokens.toLocaleString()} | ${n.totalTokens.toLocaleString()} | **-${red}%** |`;
}).join("\n");

const detailRows = results.map(({ old: o, new: n }) => {
  const toolTurns = o.turns.filter((t) => t.toolResult.tool !== "__answer__");
  const oldSteps = toolTurns.map((turn, i) =>
    `  - Turn ${i + 1}: \`${turn.toolResult.tool}(${JSON.stringify(turn.toolResult.args).slice(0, 60)})\`\n    Input: ${turn.inputTokens.toLocaleString()} tokens | Response: ${Math.ceil(turn.toolResult.responseBytes / 4).toLocaleString()} tokens`
  ).join("\n");

  const newTurn = n.turns[0];

  return `### ${o.taskId}: ${TASKS.find(t => t.id === o.taskId)!.question}

**Old** (${toolTurns.length} tool calls, ${o.totalTokens.toLocaleString()} total tokens):
${oldSteps}
  - Final answer turn: ${o.turns.at(-1)!.inputTokens.toLocaleString()} input tokens

**New** (1 tool call, ${n.totalTokens.toLocaleString()} total tokens):
  - Turn 1: \`execute_healthie_code\`
    Input: ${newTurn.inputTokens.toLocaleString()} tokens | Response: ${Math.ceil(newTurn.toolResult.responseBytes / 4).toLocaleString()} tokens
  - Final answer turn: ${n.turns.at(-1)!.inputTokens.toLocaleString()} input tokens

**Savings: ${Math.round((1 - n.totalTokens / o.totalTokens) * 100)}% fewer tokens**`;
}).join("\n\n---\n\n");

const report = `# Real-Life Token Comparison: Old Dev-Assist vs Code Mode

Generated: ${new Date().toISOString().split("T")[0]}

## Methodology

Token counting reflects what the LLM **actually sees on each turn**:
- System prompt (re-sent every turn)
- Full conversation history (grows each turn — this is the O(n²) effect)
- Tool definitions (re-sent every turn)
- LLM output (tool call JSON or final answer)

Token estimate: chars ÷ 4. Each LLM turn includes all prior context.

---

## Summary

| Task | Question | Old Turns | New Turns | Old Time | New Time | Speedup | Old Tokens | New Tokens | Reduction |
|------|----------|-----------|-----------|----------|----------|---------|------------|------------|-----------|
${summaryRows}
| **Total** | | **${totOldTurns}** | **${results.length}** | **${totOldMs}ms** | **${totNewMs}ms** | **${overallSpeedup}x** | **${totOld.toLocaleString()}** | **${totNew.toLocaleString()}** | **-${overallRed}%** |

**Overall: -${overallRed}% tokens | -${overallTurnRed}% tool calls | ${overallSpeedup}x faster**

---

## Per-Task Detail

${detailRows}

---

## Key Insight: Why Multi-Turn Is Expensive

In the old approach, **every turn re-reads the entire conversation**. For a 3-turn task:
- Turn 1 input: system + tools + question + turn1_output
- Turn 2 input: system + tools + question + turn1_output + turn1_result + turn2_output  ← re-reads turn 1
- Turn 3 input: system + tools + question + ALL prior turns + turn3_output              ← re-reads turns 1+2

This compounds rapidly. A 5-turn task costs roughly 3× more tokens than a 1-turn task of equivalent content.
Code Mode eliminates this by collapsing all operations into a single turn.
`;

const reportPath = new URL("./real-comparison-results.md", import.meta.url).pathname;
writeFileSync(reportPath, report, "utf-8");
console.log(`\nDetailed report saved to: ${reportPath}`);
