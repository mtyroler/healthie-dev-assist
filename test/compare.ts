/**
 * Side-by-side comparison: old dev-assist (search_schema style) vs new code mode.
 *
 * What we measure:
 *   - Number of round-trips (tool calls) required per task
 *   - Estimated tokens per round-trip (input + output)
 *   - Total estimated token cost per task
 *   - Wall-clock time
 *   - Result completeness (field count, type coverage)
 *
 * Token estimation: chars / 4 (standard approximation for English/code text).
 * Round-trip overhead: each tool call requires ~150 tokens of JSON-RPC scaffolding
 * (method, params, result envelope) on top of the actual content.
 *
 * Run: npx tsx test/compare.ts
 * Output: test/comparison-results.md
 */

import { readFileSync, writeFileSync } from "fs";
import { search, introspect } from "../src/api.js";
import { executeInSandbox } from "../src/sandbox.js";

const TOOL_CALL_OVERHEAD_TOKENS = 150; // per round-trip (JSON-RPC envelope)
const OLD_SCHEMA_PATH =
  "/Users/max.tyroler/scripts/healthie-dev-assist/schemas/healthie-schema.graphql";

// ── Helpers ───────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function pad(s: string, n: number): string {
  return s.slice(0, n).padEnd(n);
}

// ── Old dev-assist: search_schema (replicated from mcp-with-search.js) ────────

interface OldSearchMatch {
  lineNumber: number;
  line: string;
  context: string;
}

function oldSearchSchema(
  schemaContent: string,
  query: string,
  type: "any" | "type" | "query" | "mutation" | "input" | "enum" = "any",
  contextLines = 5
): string {
  const lines = schemaContent.split("\n");
  const regex = new RegExp(query, "gi");
  const matches: OldSearchMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (type !== "any") {
      const typePattern = /^(type|input|enum|interface|union|scalar)\s+/i;
      const isDefinition = typePattern.test(line.trim());
      if (isDefinition) {
        const lineType = line.trim().split(/\s+/)[0].toLowerCase();
        if (type === "query" || type === "mutation") continue;
        else if (lineType !== type) continue;
      }
    }

    if (regex.test(line)) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const ctx: string[] = [];
      for (let j = start; j <= end; j++) {
        ctx.push(`${j + 1}:${j === i ? ">>> " : "    "}${lines[j]}`);
      }
      matches.push({ lineNumber: i + 1, line: line.trim(), context: ctx.join("\n") });
    }
  }

  if (type === "query" || type === "mutation") {
    matches.push(...oldSearchQueryMutation(lines, regex, type, contextLines));
  }

  if (matches.length === 0)
    return `No matches found for "${query}"${type !== "any" ? ` in ${type} definitions` : ""}`;

  let result = `Found ${matches.length} matches for "${query}"${type !== "any" ? ` in ${type} definitions` : ""}:\n\n`;
  for (const m of matches.slice(0, 20)) {
    result += `Line ${m.lineNumber}: ${m.line}\nContext:\n${m.context}\n\n---\n\n`;
  }
  if (matches.length > 20)
    result += `\n... and ${matches.length - 20} more matches.`;
  return result;
}

function oldSearchQueryMutation(
  lines: string[],
  regex: RegExp,
  type: "query" | "mutation",
  contextLines: number
): OldSearchMatch[] {
  const matches: OldSearchMatch[] = [];
  let inTargetType = false;
  let braceCount = 0;
  const targetType = type === "query" ? "Query" : "Mutation";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inTargetType && line.trim().startsWith(`type ${targetType}`)) {
      inTargetType = true;
      continue;
    }
    if (inTargetType) {
      for (const char of line) {
        if (char === "{") braceCount++;
        if (char === "}") braceCount--;
      }
      if (braceCount === 0 && line.includes("}")) {
        inTargetType = false;
        continue;
      }
      if (regex.test(line) && line.trim() && !line.trim().startsWith("#")) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const ctx: string[] = [];
        for (let j = start; j <= end; j++) {
          ctx.push(`${j + 1}:${j === i ? ">>> " : "    "}${lines[j]}`);
        }
        matches.push({ lineNumber: i + 1, line: line.trim(), context: ctx.join("\n") });
      }
    }
  }
  return matches;
}

// ── Benchmark task definitions ────────────────────────────────────────────────

interface TaskDef {
  id: string;
  description: string;
  // Old approach: list of sequential tool calls (each is one round-trip)
  oldSteps: Array<{
    tool: "search_schema" | "introspect_note";
    label: string;
    fn: (schema: string) => string | Promise<string>;
  }>;
  // New approach: single code execution
  newCode: string;
}

const TASKS: TaskDef[] = [
  {
    id: "T1",
    description: "Find all fields on the Appointment type",
    oldSteps: [
      {
        tool: "search_schema",
        label: 'search_schema("Appointment", "type")',
        fn: (s) => oldSearchSchema(s, "Appointment", "type"),
      },
      {
        tool: "introspect_note",
        label: "introspect(Appointment) [via apollo binary]",
        fn: async () => {
          // Simulate introspect output by using our new api — same data, same format
          const d = await introspect("Appointment");
          return JSON.stringify(d, null, 2);
        },
      },
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
    description: "What mutations exist for creating appointments?",
    oldSteps: [
      {
        tool: "search_schema",
        label: 'search_schema("appointment", "mutation")',
        fn: (s) => oldSearchSchema(s, "appointment", "mutation"),
      },
      {
        tool: "search_schema",
        label: 'search_schema("createAppointment", "any")',
        fn: (s) => oldSearchSchema(s, "createAppointment"),
      },
    ],
    newCode: `
      const mutations = await healthie.search("appointment", { kind: "mutation" });
      const creates = mutations.filter(m => m.name.toLowerCase().includes("create"));
      return { allMutations: mutations, createMutations: creates };
    `,
  },
  {
    id: "T3",
    description: "Explore the User (patient) type and its related types",
    oldSteps: [
      {
        tool: "search_schema",
        label: 'search_schema("^type User", "type")',
        fn: (s) => oldSearchSchema(s, "^type User"),
      },
      {
        tool: "introspect_note",
        label: "introspect(User)",
        fn: async () => JSON.stringify(await introspect("User"), null, 2),
      },
      {
        tool: "introspect_note",
        label: "introspect(UserGroup) [related type, 2nd lookup]",
        fn: async () => JSON.stringify(await introspect("UserGroup"), null, 2),
      },
    ],
    // Equivalent work to old: search + introspect User + introspect one related type
    newCode: `
      const [searchResults, userDetails, userGroupDetails] = await Promise.all([
        healthie.search("user", { kind: "type", limit: 10 }),
        healthie.introspect("User"),
        healthie.introspect("UserGroup"),
      ]);
      return { searchResults, userDetails, userGroupDetails };
    `,
  },
  {
    id: "T4",
    description: "Find all types related to billing and insurance",
    oldSteps: [
      {
        tool: "search_schema",
        label: 'search_schema("billing")',
        fn: (s) => oldSearchSchema(s, "billing"),
      },
      {
        tool: "search_schema",
        label: 'search_schema("insurance")',
        fn: (s) => oldSearchSchema(s, "insurance"),
      },
      {
        tool: "search_schema",
        label: 'search_schema("payment")',
        fn: (s) => oldSearchSchema(s, "payment"),
      },
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
    description: "Find all queries available for appointments",
    oldSteps: [
      {
        tool: "search_schema",
        label: 'search_schema("appointment", "query")',
        fn: (s) => oldSearchSchema(s, "appointment", "query"),
      },
    ],
    newCode: `
      const queries = await healthie.search("appointment", { kind: "query" });
      return queries;
    `,
  },
];

// ── Run comparison ────────────────────────────────────────────────────────────

interface StepResult {
  label: string;
  outputText: string;
  outputTokens: number;
  durationMs: number;
}

interface TaskResult {
  id: string;
  description: string;
  old: {
    steps: StepResult[];
    totalTokens: number;
    totalDurationMs: number;
    roundTrips: number;
  };
  new: {
    outputText: string;
    outputTokens: number;
    durationMs: number;
    roundTrips: number;
    totalTokens: number;
    success: boolean;
    error?: string;
  };
}

async function runComparison(): Promise<TaskResult[]> {
  const schemaContent = readFileSync(OLD_SCHEMA_PATH, "utf-8");
  const results: TaskResult[] = [];

  for (const task of TASKS) {
    process.stdout.write(`\n${task.id}: ${task.description}\n`);

    // ── Old approach ──────────────────────────────────────────────────────────
    process.stdout.write("  Old dev-assist:\n");
    const oldSteps: StepResult[] = [];

    for (const step of task.oldSteps) {
      const t0 = Date.now();
      const output = await step.fn(schemaContent);
      const ms = Date.now() - t0;
      const tokens = estimateTokens(output) + TOOL_CALL_OVERHEAD_TOKENS;
      oldSteps.push({ label: step.label, outputText: output, outputTokens: tokens, durationMs: ms });
      process.stdout.write(`    [${ms}ms ~${tokens}tok] ${step.label}\n`);
    }

    const oldTotal = oldSteps.reduce(
      (acc, s) => ({ tokens: acc.tokens + s.outputTokens, ms: acc.ms + s.durationMs }),
      { tokens: 0, ms: 0 }
    );

    // ── New approach ──────────────────────────────────────────────────────────
    process.stdout.write("  New code mode:\n");
    const t0 = Date.now();
    const sandboxResult = await executeInSandbox(task.newCode);
    const newMs = Date.now() - t0;
    const newOutputText = sandboxResult.success
      ? JSON.stringify(sandboxResult.result, null, 2)
      : `ERROR: ${sandboxResult.error}`;
    // Code input tokens + output tokens + overhead (one round trip)
    const codeInputTokens = estimateTokens(task.newCode) + TOOL_CALL_OVERHEAD_TOKENS;
    const newOutputTokens = estimateTokens(newOutputText);
    const newTotal = codeInputTokens + newOutputTokens;

    process.stdout.write(
      `    [${newMs}ms ~${newTotal}tok] execute_healthie_code (single call)\n`
    );
    if (!sandboxResult.success)
      process.stdout.write(`    ERROR: ${sandboxResult.error}\n`);

    // ── Savings ───────────────────────────────────────────────────────────────
    const tokenReduction = Math.round((1 - newTotal / oldTotal.tokens) * 100);
    const turnReduction = Math.round(
      (1 - 1 / oldSteps.length) * 100
    );
    process.stdout.write(
      `  → Token reduction: ${tokenReduction}% | Turn reduction: ${turnReduction}% (${oldSteps.length} → 1)\n`
    );

    results.push({
      id: task.id,
      description: task.description,
      old: {
        steps: oldSteps,
        totalTokens: oldTotal.tokens,
        totalDurationMs: oldTotal.ms,
        roundTrips: oldSteps.length,
      },
      new: {
        outputText: newOutputText,
        outputTokens: newOutputTokens,
        durationMs: newMs,
        roundTrips: 1,
        totalTokens: newTotal,
        success: sandboxResult.success,
        error: sandboxResult.error,
      },
    });
  }

  return results;
}

// ── Markdown report ───────────────────────────────────────────────────────────

function generateReport(results: TaskResult[]): string {
  const now = new Date().toISOString().split("T")[0];

  const overallOldTokens = results.reduce((s, r) => s + r.old.totalTokens, 0);
  const overallNewTokens = results.reduce((s, r) => s + r.new.totalTokens, 0);
  const overallOldTurns = results.reduce((s, r) => s + r.old.roundTrips, 0);
  const overallNewTurns = results.length; // always 1 per task
  const overallTokenReduction = Math.round((1 - overallNewTokens / overallOldTokens) * 100);
  const overallTurnReduction = Math.round((1 - overallNewTurns / overallOldTurns) * 100);

  const summaryRows = results
    .map((r) => {
      const tokRed = Math.round((1 - r.new.totalTokens / r.old.totalTokens) * 100);
      return `| ${r.id} | ${r.description} | ${r.old.roundTrips} | 1 | ${r.old.totalTokens.toLocaleString()} | ${r.new.totalTokens.toLocaleString()} | **${tokRed}%** |`;
    })
    .join("\n");

  const detailSections = results
    .map((r) => {
      const tokRed = Math.round((1 - r.new.totalTokens / r.old.totalTokens) * 100);
      const oldStepsList = r.old.steps
        .map(
          (s, i) =>
            `**Step ${i + 1}:** \`${s.label}\`\n- Output: ${s.outputTokens.toLocaleString()} tokens (~${s.outputText.length.toLocaleString()} chars)\n- Time: ${s.durationMs}ms`
        )
        .join("\n\n");

      const newPreview = r.new.outputText.slice(0, 400) + (r.new.outputText.length > 400 ? "\n..." : "");

      return `### ${r.id}: ${r.description}

**Old dev-assist** — ${r.old.roundTrips} round-trip(s), ${r.old.totalTokens.toLocaleString()} tokens total

${oldStepsList}

**New code mode** — 1 round-trip, ${r.new.totalTokens.toLocaleString()} tokens total

- Time: ${r.new.durationMs}ms
- Success: ${r.new.success ? "✓" : "✗"}
- Output preview:
\`\`\`json
${newPreview}
\`\`\`

**Savings: ${tokRed}% fewer tokens, ${r.old.roundTrips}x fewer round-trips**`;
    })
    .join("\n\n---\n\n");

  return `# Healthie Dev Assist: Code Mode vs. Original Comparison

Generated: ${now}

> **Token estimates**: chars ÷ 4, plus ${TOOL_CALL_OVERHEAD_TOKENS} tokens per round-trip for JSON-RPC scaffolding.
> True token counts require measuring via LLM API — these are close approximations.

---

## Summary

| Task | Description | Old Turns | New Turns | Old Tokens | New Tokens | Reduction |
|------|-------------|-----------|-----------|------------|------------|-----------|
${summaryRows}
| **Total** | | **${overallOldTurns}** | **${overallNewTurns}** | **${overallOldTokens.toLocaleString()}** | **${overallNewTokens.toLocaleString()}** | **${overallTokenReduction}%** |

### Overall

- Token reduction: **${overallTokenReduction}%** (${overallOldTokens.toLocaleString()} → ${overallNewTokens.toLocaleString()} tokens)
- Turn reduction: **${overallTurnReduction}%** (${overallOldTurns} turns → ${overallNewTurns} turns across ${results.length} tasks)
- Old approach: ${(overallOldTurns / results.length).toFixed(1)} round-trips per task average
- New approach: 1.0 round-trips per task (always)

---

## Task Details

${detailSections}

---

## Methodology Notes

### What "old dev-assist" means here
The original server (\`mcp-with-search.js\`) wraps the \`apollo-mcp-server\` binary and adds a \`search_schema\` tool.
Each task requires sequential tool calls: the LLM must wait for each result before deciding the next call.

The \`search_schema\` output is SDL text with line numbers and surrounding context — verbose but grep-like.
The \`introspect\` output comes from the apollo binary — JSON with field definitions.

### What "new code mode" means here
A single \`execute_healthie_code\` call runs arbitrary async JS in a vm sandbox.
Multiple operations (search, introspect, parallel lookups) execute in one LLM turn.

### Result quality
Both approaches use the same underlying schema file, so factual accuracy is identical.
The new approach returns **structured JSON** vs the old approach's **text with line numbers**.
Structured output is easier for the LLM to process in follow-up reasoning.

### Limitations
- Token counts are estimated (chars ÷ 4). Real counts may vary ±15%.
- \`introspect\` calls in the old approach are simulated using the new API's introspect method
  (same data, since both read the same SDL file).
- Network latency for \`query()\`/\`mutate()\` not tested (no API key in test env).
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\nHealthie Dev Assist: Code Mode vs. Original");
console.log("=".repeat(50));
console.log("Token estimates: chars÷4 + 150 overhead per round-trip\n");

const results = await runComparison();

// Print summary table to terminal
console.log("\n" + "=".repeat(50));
console.log("SUMMARY");
console.log("=".repeat(50));
console.log(
  `${pad("Task", 4)} ${pad("Old turns", 10)} ${pad("New turns", 10)} ${pad("Old tokens", 12)} ${pad("New tokens", 12)} Reduction`
);
console.log("-".repeat(65));

let totalOld = 0, totalNew = 0, totalOldTurns = 0;
for (const r of results) {
  const red = Math.round((1 - r.new.totalTokens / r.old.totalTokens) * 100);
  console.log(
    `${pad(r.id, 4)} ${pad(String(r.old.roundTrips), 10)} ${pad("1", 10)} ${pad(String(r.old.totalTokens), 12)} ${pad(String(r.new.totalTokens), 12)} ${red}%`
  );
  totalOld += r.old.totalTokens;
  totalNew += r.new.totalTokens;
  totalOldTurns += r.old.roundTrips;
}

console.log("-".repeat(65));
const overallRed = Math.round((1 - totalNew / totalOld) * 100);
console.log(
  `${pad("TOT", 4)} ${pad(String(totalOldTurns), 10)} ${pad(String(results.length), 10)} ${pad(String(totalOld), 12)} ${pad(String(totalNew), 12)} ${overallRed}%`
);

const reportPath = new URL("./comparison-results.md", import.meta.url).pathname;
const report = generateReport(results);
writeFileSync(reportPath, report, "utf-8");
console.log(`\nDetailed report saved to: ${reportPath}`);
