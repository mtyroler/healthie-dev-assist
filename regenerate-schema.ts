/**
 * Regenerate the Healthie GraphQL schema via introspection.
 *
 * Usage: npm run regenerate-schema
 *
 * Downloads the full schema from the Healthie API and saves it as SDL
 * to ./schemas/<env>.graphql
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import {
  buildClientSchema,
  getIntrospectionQuery,
  printSchema,
  IntrospectionQuery,
} from "graphql";
import { config } from "./config.js";

const INTROSPECTION_QUERY = getIntrospectionQuery();

async function introspect(): Promise<IntrospectionQuery> {
  console.log(`Fetching schema from ${config.apiUrl} (env: ${config.envName})...`);

  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${config.apiKey}`,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} from ${config.apiUrl}: ${text}`);
  }

  const json = (await response.json()) as {
    data?: IntrospectionQuery;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Introspection errors: ${messages}`);
  }

  if (!json.data) {
    throw new Error("No data returned from introspection query");
  }

  return json.data;
}

async function main() {
  try {
    const introspectionResult = await introspect();

    // Build schema from introspection result and convert to SDL
    const schema = buildClientSchema(introspectionResult);
    const sdl = printSchema(schema);

    // Ensure output directory exists
    const outputDir = dirname(config.schemaPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(config.schemaPath, sdl, "utf-8");
    console.log(`✓ Schema saved to ${config.schemaPath}`);
    console.log(`  ${sdl.split("\n").length} lines`);
  } catch (err) {
    console.error("Error regenerating schema:", err);
    process.exit(1);
  }
}

main();
