# Healthie Dev Assist 2.0

A high-performance MCP server that connects AI assistants to Healthie's GraphQL API. Instead of one tool call at a time, the AI writes and executes code that performs multiple operations in a single turn.

## What's New in 2.0

The original Healthie Dev Assist exposed Healthie's GraphQL schema directly to your AI tool. This worked, but required many back-and-forth turns: search for a type, wait, introspect it, wait, build a query, wait, execute it, wait.

**Dev Assist 2.0** changes the execution model. Instead of one tool call per operation, your AI writes a small TypeScript program that performs all the steps in a single execution — searching the schema, introspecting types, and running queries in one shot.

| | v1 | v2 |
|---|---|---|
| Turns to complete a typical task | 5–10 | 1–2 |
| Schema exploration | One call at a time | Search + introspect + query in one execution |
| Tool calls exposed | Many | One (`execute_healthie_code`) |
| Schema | Fetched live each turn | Cached locally, instant lookup |

**Example:** asking Claude to "find all appointment mutations and show me what arguments `createAppointment` takes" previously required 3+ tool calls. In 2.0, Claude writes one block of code that does it all at once:

```typescript
const mutations = await healthie.search("appointment", { kind: "mutation" });
const details = await healthie.introspect("createAppointmentInput");
return { mutations, details };
```

## How It Works

Your AI assistant has access to one tool: `execute_healthie_code`. It writes async TypeScript using a `healthie` object:

```typescript
// Search the schema
healthie.search(query, options?) → SearchResult[]

// Get full details on any type
healthie.introspect(typeName, options?) → TypeDetails

// Execute a real GraphQL query against the Healthie API
healthie.query(graphql, variables?) → any

// Execute a mutation
healthie.mutate(graphql, variables?) → any
```

Code runs in a sandboxed Node.js environment with no access to the filesystem, network, or shell — only the `healthie` object.

## Prerequisites

- Node.js v18 or higher
- npm
- A Healthie API key (required for `query`/`mutate`; schema search works without one)

## Installation

### 1. Clone and install

```bash
git clone https://github.com/healthie/healthie-dev-assist.git
cd healthie-dev-assist
npm install
```

### 2. Add your API key

```bash
cp .env.example .env
```

Edit `.env`:
```
HEALTHIE_API_KEY=your-api-key-here
```

### 3. Download the schema

```bash
npm run regenerate-schema
```

This fetches Healthie's GraphQL schema and caches it locally. Re-run whenever the API changes.

### 4. Run setup (Claude Desktop only)

```bash
npm run setup
```

Restart Claude Desktop after this runs.

### 5. Connect your AI tool (non-Desktop)

#### Claude Code (CLI)

```bash
claude mcp add healthie -- npx tsx /path/to/healthie-dev-assist/src/server.ts
```

Verify:
```bash
claude mcp list
```

#### Cursor

Add to Cursor's MCP settings:

```json
{
  "mcp": {
    "servers": {
      "healthie": {
        "command": "npx",
        "args": ["tsx", "/path/to/healthie-dev-assist/src/server.ts"]
      }
    }
  }
}
```

#### Built version (faster startup)

```bash
npm run build
```

Then use `node /path/to/healthie-dev-assist/dist/server.js` instead of `npx tsx ...` in any of the configs above.

## Usage

Once connected, just ask your AI assistant naturally:

- *"Find all patient-related queries and show me what fields are available"*
- *"What arguments does createAppointment take?"*
- *"Fetch the last 5 appointments for patient ID 123"*
- *"Show me all mutations related to billing"*

The AI handles schema exploration and API calls in one or two turns.

## Multi-Instance Support

To run multiple instances (e.g. different staging accounts), copy the example config:

```bash
cp environments.example.json environments.json
```

Edit `environments.json`:
```json
{
  "staging": {
    "apiUrl": "https://staging-api.gethealthie.com/graphql",
    "apiKey": "your-staging-key"
  }
}
```

Add a separate MCP server entry per instance in your AI tool config:

```json
{
  "mcpServers": {
    "healthie-staging": {
      "command": "npx",
      "args": ["tsx", "/path/to/healthie-dev-assist/src/server.ts"],
      "env": { "HEALTHIE_ENV": "staging" }
    }
  }
}
```

## Troubleshooting

**`Schema not found`**
Run `npm run regenerate-schema`. Make sure your API key is set in `.env`.

**`HEALTHIE_API_KEY required`**
Schema search and introspection work without a key, but `query`/`mutate` require one. Add it to `.env` or `environments.json`.

**Tool not appearing in Claude**
Use absolute paths (not `~/` or relative paths) in the MCP config. Restart your AI tool after changing config.

**`Module not found` / `Cannot find package`**
Run `npm install` from the project directory.

## ⚠️ Security Note

This tool is intended for use with Healthie's staging environment only. Do not connect it to production — most AI platforms do not have a Business Associate Agreement (BAA) in place, and production Healthie data contains PHI.

## License

MIT

## Support

- [GitHub Issues](https://github.com/healthie/healthie-dev-assist/issues)
- [Healthie API Documentation](https://docs.gethealthie.com/guides/intro/)
