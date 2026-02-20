import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { buildSchema, GraphQLSchema } from "graphql";
import { config } from "../config.js";

let cachedSchema: GraphQLSchema | null = null;
let cachedSdl: string | null = null;

export function getSchemaPath(): string {
  return config.schemaPath;
}

export function ensureSchemaDirExists(): void {
  const dir = dirname(config.schemaPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function schemaExists(): boolean {
  return existsSync(config.schemaPath);
}

export function loadSdl(): string {
  if (cachedSdl) return cachedSdl;

  if (!schemaExists()) {
    throw new Error(
      `Schema not found at ${config.schemaPath}. Run: npm run regenerate-schema`
    );
  }

  cachedSdl = readFileSync(config.schemaPath, "utf-8");
  return cachedSdl;
}

export function loadSchema(): GraphQLSchema {
  if (cachedSchema) return cachedSchema;

  const sdl = loadSdl();
  cachedSchema = buildSchema(sdl);
  return cachedSchema;
}

export function invalidateCache(): void {
  cachedSchema = null;
  cachedSdl = null;
}
