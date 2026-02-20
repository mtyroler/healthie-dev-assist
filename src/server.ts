import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeInSandbox } from "./sandbox.js";
import { SYSTEM_PROMPT, TOOL_TYPE_HINT } from "./types.js";
import { schemaExists } from "./schema.js";
import { config } from "../config.js";

// ── Auto-regenerate schema on startup if missing ──────────────────────────────

async function ensureSchema(): Promise<void> {
  if (!schemaExists()) {
    console.error(
      `[healthie-dev-assist] Schema not found at ${config.schemaPath}`
    );
    console.error(
      "[healthie-dev-assist] Run: npm run regenerate-schema"
    );
    console.error(
      "[healthie-dev-assist] Starting without schema — tools will fail until schema is generated."
    );
  } else {
    console.error(
      `[healthie-dev-assist] Schema loaded from ${config.schemaPath} (env: ${config.envName})`
    );
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "healthie-dev-assist",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// ── Tool: execute_healthie_code ───────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_healthie_code",
      description: `Execute TypeScript/JavaScript code to explore the Healthie GraphQL schema and API.

Write async code using the \`healthie\` object. All operations run in one execution — no back-and-forth.

${TOOL_TYPE_HINT}

Examples:
  // Search + introspect in one call
  const types = await healthie.search("appointment");
  const details = await healthie.introspect("Appointment");
  return { types, details };

  // Find all mutations for a resource
  const mutations = await healthie.search("patient", { kind: "mutation" });
  return mutations;

  // Execute a real API query
  const data = await healthie.query(\`query { patients(first: 3) { nodes { id firstName } } }\`);
  return data;`,
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Async JavaScript/TypeScript code to execute. Use `return` to output results. All healthie.* methods are async — use await.",
          },
        },
        required: ["code"],
      },
    },
  ],
}));

const ExecuteCodeSchema = z.object({
  code: z.string().max(50_000),
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "execute_healthie_code") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { code } = ExecuteCodeSchema.parse(request.params.arguments);

  const result = await executeInSandbox(code);

  if (result.success) {
    const output =
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2);

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${result.error}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Prompt: healthie_context ──────────────────────────────────────────────────
// Provides the system prompt with TypeScript types when requested

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "healthie_context",
      description:
        "System context for Healthie API exploration. Include this in your system prompt.",
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "healthie_context") {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }

  return {
    description: "Healthie API exploration context",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: SYSTEM_PROMPT,
        },
      },
    ],
  };
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  // Strip process.env after config loads — limits sandbox escape blast radius.
  // config.ts already captured HEALTHIE_API_KEY and all settings it needs;
  // env vars serve no further purpose for the lifetime of the server.
  Object.keys(process.env).forEach(k => delete process.env[k]);

  await ensureSchema();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[healthie-dev-assist] MCP server started on stdio");
}

main().catch((err) => {
  console.error("[healthie-dev-assist] Fatal error:", err);
  process.exit(1);
});
