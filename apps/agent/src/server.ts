import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentExecutionReceiptSchema } from "@deploylite/contracts";
import { createAgentExecutionHandler, type AgentReplayStore, type AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

export type AgentServerOptions = Readonly<{ host: string; port: number; receiver: AuthenticatedAgentCommandReceiver; replayStore: AgentReplayStore; production?: boolean; maxBodyBytes?: number }>;
export async function startAgentServer(options: AgentServerOptions) {
  if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || (options.production && options.port === 0)) throw new Error("agent bind configuration is invalid");
  if (!options.replayStore || (options.production && (options.replayStore.durable !== true || !options.receiver.hasDurableReplayStore()))) throw new Error("durable agent replay store is required");
  const handler = createAgentExecutionHandler(options.receiver); const active = new Set<AbortController>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ready", service: "deploylite-agent" })); return; }
    if (request.method !== "POST" || request.url !== "/deployments/execute") { response.writeHead(404).end(); return; }
    const controller = new AbortController(); active.add(controller); let settled = false; request.once("aborted", () => { if (!settled) controller.abort(); });
    try { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > (options.maxBodyBytes ?? 1_048_576)) throw new Error("payload too large"); chunks.push(Buffer.from(chunk)); } const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); const result = await handler(body, { "x-deploylite-signature": typeof request.headers["x-deploylite-signature"] === "string" ? request.headers["x-deploylite-signature"] : undefined }, controller.signal); if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(agentExecutionReceiptSchema.parse(result))); } catch (error) { const message = error instanceof Error ? error.message : "agent command rejected"; const status = /authentication/.test(message) ? 401 : /capability|scope/.test(message) ? 403 : /expired|conflict|payload/.test(message) ? 409 : 400; if (!response.destroyed) response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message.replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]") })); } finally { settled = true; active.delete(controller); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); }); });
  return { server, host: options.host, port: options.port, close: async () => { for (const controller of active) controller.abort(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
