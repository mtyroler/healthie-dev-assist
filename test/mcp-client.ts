/**
 * Minimal MCP stdio client.
 * Starts a server process, sends JSON-RPC messages, returns responses.
 */

import { spawn, ChildProcess } from "child_process";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  responseText: string;
  responseBytes: number;
  durationMs: number;
  isError: boolean;
}

export class McpClient {
  private proc: ChildProcess;
  private buffer = "";
  private pendingResolvers = new Map<
    number,
    (msg: Record<string, unknown>) => void
  >();
  private msgId = 1;
  private ready = false;

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pendingResolvers.has(id)) {
            this.pendingResolvers.get(id)!(msg);
            this.pendingResolvers.delete(id);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    this.proc.stderr!.on("data", () => {
      // suppress server logs
    });
  }

  async initialize(): Promise<void> {
    const resp = await this.send({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "compare-harness", version: "1.0" },
      },
    });
    if (!resp.result) throw new Error("initialize failed");

    await this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, true);
    this.ready = true;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.ready) throw new Error("Client not initialized");
    const t0 = Date.now();
    const resp = await this.send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const durationMs = Date.now() - t0;

    const result = resp.result as Record<string, unknown> | undefined;
    const content = result?.content as Array<{ type: string; text: string }> | undefined;
    const responseText = content?.map((c) => c.text).join("\n") ?? JSON.stringify(resp);
    const isError = !!(resp.error || result?.isError);

    return {
      tool,
      args,
      responseText,
      responseBytes: Buffer.byteLength(responseText, "utf8"),
      durationMs,
      isError,
    };
  }

  private send(
    msg: Record<string, unknown>,
    noResponse = false
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (noResponse) {
        this.proc.stdin!.write(JSON.stringify(msg) + "\n");
        resolve({});
        return;
      }
      const id = this.msgId++;
      msg.id = id;
      this.pendingResolvers.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  close(): void {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}
