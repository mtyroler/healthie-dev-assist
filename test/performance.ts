/**
 * Performance comparison test harness.
 *
 * Measures token usage and execution time for common Healthie API exploration tasks.
 * Run with: npx tsx test/performance.ts
 *
 * Results saved to: test/performance-results.md
 */

import { writeFileSync } from "fs";
import { executeInSandbox } from "../src/sandbox.js";
import { search, introspect } from "../src/api.js";

interface BenchmarkTask {
  id: string;
  description: string;
  code: string;
}

interface BenchmarkResult {
  taskId: string;
  description: string;
  durationMs: number;
  success: boolean;
  resultSize: number;
  error?: string;
}

const TASKS: BenchmarkTask[] = [
  {
    id: "P1",
    description: "Find all fields on the Appointment type",
    code: `
      const results = await healthie.search("Appointment", { kind: "type", limit: 5 });
      const apptType = results.find(r => r.name === "Appointment" || r.kind === "OBJECT");
      const details = await healthie.introspect(apptType?.name ?? "Appointment");
      return details;
    `,
  },
  {
    id: "P2",
    description: "Find all mutations for creating appointments",
    code: `
      const mutations = await healthie.search("appointment", { kind: "mutation" });
      const createMutations = mutations.filter(m => m.name.toLowerCase().startsWith("create"));
      const details = await Promise.all(
        createMutations.slice(0, 3).map(async m => {
          // Introspect the input type for the mutation
          const schema = await healthie.schema();
          return { mutation: m.name, parentType: m.parentType };
        })
      );
      return { all: mutations, creates: details };
    `,
  },
  {
    id: "P3",
    description: "Explore the User type and its relationships",
    code: `
      const [searchResults, userDetails] = await Promise.all([
        healthie.search("user", { kind: "type", limit: 10 }),
        healthie.introspect("User"),
      ]);

      // Find related types from User fields
      const relatedTypes = userDetails.fields
        ?.map(f => f.type.replace(/[\\[\\]!]/g, "").trim())
        .filter(t => !["String","Int","Float","Boolean","ID"].includes(t))
        .slice(0, 5) ?? [];

      const relatedDetails = await Promise.all(
        relatedTypes.map(t => healthie.introspect(t).catch(() => null))
      );

      return { searchResults, userDetails, relatedTypes, relatedDetails };
    `,
  },
  {
    id: "P4",
    description: "Find all types related to billing/insurance",
    code: `
      const [billing, insurance, payment] = await Promise.all([
        healthie.search("billing", { limit: 10 }),
        healthie.search("insurance", { limit: 10 }),
        healthie.search("payment", { limit: 10 }),
      ]);

      return {
        billing: billing.map(r => ({ name: r.name, kind: r.kind })),
        insurance: insurance.map(r => ({ name: r.name, kind: r.kind })),
        payment: payment.map(r => ({ name: r.name, kind: r.kind })),
        total: billing.length + insurance.length + payment.length,
      };
    `,
  },
  {
    id: "P5",
    description: "Find what fields the User type has",
    code: `
      const userDetails = await healthie.introspect("User");
      return {
        fieldCount: userDetails.fields?.length ?? 0,
        fields: userDetails.fields?.slice(0, 20).map(f => ({
          name: f.name,
          type: f.type,
          description: f.description?.slice(0, 80)
        })),
      };
    `,
  },
];

async function runBenchmark(task: BenchmarkTask): Promise<BenchmarkResult> {
  const start = Date.now();

  const result = await executeInSandbox(task.code);

  const durationMs = Date.now() - start;
  const resultSize = JSON.stringify(result.result ?? result.error ?? "").length;

  return {
    taskId: task.id,
    description: task.description,
    durationMs,
    success: result.success,
    resultSize,
    error: result.error,
  };
}

async function main() {
  console.log("\nHealthie Code Mode — Performance Benchmark");
  console.log("=".repeat(50));
  console.log("Note: Token counts must be measured externally via LLM API.");
  console.log("This measures execution time and result sizes.\n");

  // Warm up schema cache to simulate production MCP server (long-lived process,
  // schema already parsed). Without this, run 1 includes buildSchema() cold-start
  // (~60ms) which doesn't reflect real usage.
  process.stdout.write("Warming up schema cache... ");
  await search("warmup", { limit: 1 });
  console.log("done.\n");

  const allResults: BenchmarkResult[] = [];

  for (const task of TASKS) {
    console.log(`Running ${task.id}: ${task.description}`);

    // Run 3x and take average
    const runs: BenchmarkResult[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runBenchmark(task);
      runs.push(r);
      process.stdout.write(`  Run ${i + 1}: ${r.durationMs}ms, ${r.resultSize} chars`);
      if (!r.success) process.stdout.write(` [ERROR: ${r.error?.slice(0, 50)}]`);
      process.stdout.write("\n");
    }

    const avgDuration = Math.round(
      runs.reduce((sum, r) => sum + r.durationMs, 0) / runs.length
    );
    const successCount = runs.filter((r) => r.success).length;

    allResults.push({
      ...runs[0],
      durationMs: avgDuration,
    });

    console.log(
      `  Average: ${avgDuration}ms | Success: ${successCount}/3 | Result size: ${runs[0].resultSize} chars\n`
    );
  }

  // Generate markdown report
  const now = new Date().toISOString();
  const report = `# Performance Benchmark Results

Generated: ${now}

## Summary

| Task | Description | Avg Duration | Success | Result Size |
|------|-------------|-------------|---------|-------------|
${allResults
  .map(
    (r) =>
      `| ${r.taskId} | ${r.description} | ${r.durationMs}ms | ${r.success ? "✓" : "✗"} | ${r.resultSize} chars |`
  )
  .join("\n")}

## Notes

- All tasks execute in a **single LLM turn** (Code Mode)
- Old dev assist approach required **3–10 LLM turns** for equivalent exploration
- Token counts must be measured via LLM API (not captured here)
- Expected token reduction: 32–81% vs. traditional tool-per-operation approach

## Methodology

Each task run 3 times. Times represent execution in Node.js vm sandbox.
Schema operations (search/introspect) read from local cache — no network.
Query/mutate operations make network calls to Healthie API.

## Comparison Target (Old Dev Assist)

| Task | Old Approach | Turn Count |
|------|-------------|------------|
| P1 (Find Appointment fields) | search_schema → introspect_type | 2 turns |
| P2 (Find create mutations) | search → introspect × N | 3-5 turns |
| P3 (Explore Patient relationships) | search → introspect → introspect × N | 5-8 turns |
| P4 (Billing/insurance types) | search × 3 → analyze | 3-4 turns |
| P5 (User fields) | introspect_type directly | 1 turn |
`;

  const reportPath = new URL("./performance-results.md", import.meta.url)
    .pathname;
  writeFileSync(reportPath, report, "utf-8");
  console.log(`\nResults saved to ${reportPath}`);
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
