import {MANAGED_DATABASE_METRICS_PATH,managedDatabaseMetricsObservationSchema} from "@deploylite/contracts";
import {MANAGED_DATABASE_HEALTH_PATH,managedDatabaseHealthObservationSchema} from "@deploylite/contracts";
import {MANAGED_DATABASE_START_PATH,MANAGED_DATABASE_START_RECEIPT_PATH,managedDatabaseStartReceiptSchema,managedDatabaseStartCachedReceiptSchema} from "@deploylite/contracts";
import {MANAGED_DATABASE_STOP_PATH,MANAGED_DATABASE_STOP_RECEIPT_PATH,managedDatabaseStopReceiptSchema,managedDatabaseStopCachedReceiptSchema} from "@deploylite/contracts";
import {MANAGED_DATABASE_RUNTIME_PATH, MANAGED_DATABASE_RUNTIME_RECEIPT_PATH, managedDatabaseRuntimeReceiptSchema, managedDatabaseRuntimeCachedReceiptSchema} from "@deploylite/contracts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentCachedReceiptSchema, agentCapabilityHandshakeSchema, agentExecutionReceiptSchema, composeNetworkAttachmentCachedReceiptSchema, composeNetworkAttachmentReceiptSchema, COMPOSE_NETWORK_ATTACHMENT_PATH, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, composeResourceCleanupCachedReceiptSchema, composeResourceCleanupExecutionReceiptSchema, COMPOSE_RESOURCE_CLEANUP_PATH, COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH, composeVolumeAttachmentCachedReceiptSchema, composeVolumeAttachmentReceiptSchema, COMPOSE_VOLUME_ATTACHMENT_PATH, COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH, composeResourceInspectionAgentResponseSchema, COMPOSE_RESOURCE_INSPECTION_PATH, composeVolumeBackupCachedReceiptSchema, composeVolumeBackupReceiptSchema, COMPOSE_VOLUME_BACKUP_PATH, COMPOSE_VOLUME_BACKUP_RECEIPT_PATH, deploymentStopAgentReceiptSchema } from "@deploylite/contracts";
import { createAgentExecutionHandler, type AgentReplayStore, type AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
import { domainRouteApplyCachedReceiptSchema, domainRouteApplyReceiptSchema, DOMAIN_ROUTE_APPLY_PATH, DOMAIN_ROUTE_APPLY_RECEIPT_PATH } from "@deploylite/contracts";
import { transportPortApplyCachedReceiptSchema, transportPortApplyReceiptSchema, TRANSPORT_PORT_APPLY_PATH, TRANSPORT_PORT_APPLY_RECEIPT_PATH } from "@deploylite/contracts";

export type AgentServerOptions = Readonly<{ host: string; port: number; receiver: AuthenticatedAgentCommandReceiver; replayStore: AgentReplayStore; production?: boolean; maxBodyBytes?: number; protocolVersions?: readonly (1 | 2)[] }>;
export async function startAgentServer(options: AgentServerOptions) {
  if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || (options.production && options.port === 0)) throw new Error("agent bind configuration is invalid");
  if (!options.replayStore || (options.production && (options.replayStore.durable !== true || !options.receiver.hasDurableReplayStore()))) throw new Error("durable agent replay store is required");
  const handler = createAgentExecutionHandler(options.receiver); const active = new Set<AbortController>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ready", service: "deploylite-agent" })); return; }
    if (request.method === "GET" && request.url === "/capabilities") { const requestTarget = "GET /capabilities"; const signature = typeof request.headers["x-deploylite-signature"] === "string" ? request.headers["x-deploylite-signature"] : undefined; if (!options.receiver.verifyRequest(requestTarget, signature)) { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "agent authentication failed" })); return; } const handshake = agentCapabilityHandshakeSchema.parse({ schemaVersion: 1, agentId: options.receiver.agentId, capabilities: options.receiver.capabilities, protocolVersions: options.protocolVersions ?? [1, 2] }); response.writeHead(200, { "content-type": "application/json", "x-deploylite-request-signature": signature! }).end(JSON.stringify(handshake)); return; }
    if (request.method !== "POST" || !["/deployments/execute", "/deployments/stop", "/deployments/receipt", COMPOSE_NETWORK_ATTACHMENT_PATH, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, COMPOSE_VOLUME_ATTACHMENT_PATH, COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH, COMPOSE_RESOURCE_INSPECTION_PATH, COMPOSE_RESOURCE_CLEANUP_PATH, COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH, COMPOSE_VOLUME_BACKUP_PATH, COMPOSE_VOLUME_BACKUP_RECEIPT_PATH, DOMAIN_ROUTE_APPLY_PATH, DOMAIN_ROUTE_APPLY_RECEIPT_PATH, TRANSPORT_PORT_APPLY_PATH, TRANSPORT_PORT_APPLY_RECEIPT_PATH, MANAGED_DATABASE_RUNTIME_PATH, MANAGED_DATABASE_RUNTIME_RECEIPT_PATH, MANAGED_DATABASE_STOP_PATH, MANAGED_DATABASE_STOP_RECEIPT_PATH, MANAGED_DATABASE_START_PATH, MANAGED_DATABASE_START_RECEIPT_PATH, MANAGED_DATABASE_HEALTH_PATH,MANAGED_DATABASE_METRICS_PATH].includes(request.url ?? "")) { response.writeHead(404).end(); return; }
    const controller = new AbortController(); active.add(controller); let settled = false; request.once("aborted", () => { if (!settled) controller.abort(); });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > (options.maxBodyBytes ?? 1_048_576)) throw new Error("payload too large"); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const nativePath = request.url === MANAGED_DATABASE_RUNTIME_PATH || request.url === MANAGED_DATABASE_RUNTIME_RECEIPT_PATH;
      const nativeAction = typeof body === "object" && body !== null && body.action === "database.runtime";
      const stopPath=request.url===MANAGED_DATABASE_STOP_PATH || request.url===MANAGED_DATABASE_STOP_RECEIPT_PATH;
      const stopAction=typeof body==="object" && body!==null && body.action==="database.runtime.stop";
      const startPath=request.url===MANAGED_DATABASE_START_PATH || request.url===MANAGED_DATABASE_START_RECEIPT_PATH;
      const startAction=typeof body==="object" && body!==null && body.action==="database.runtime.start";
      const metricsPath=request.url===MANAGED_DATABASE_METRICS_PATH;
      const metricsAction=typeof body==="object" && body!==null && body.action==="database.runtime.metrics";
      const healthPath=request.url===MANAGED_DATABASE_HEALTH_PATH;
      const healthAction=typeof body==="object" && body!==null && body.action==="database.runtime.health";
      if (metricsPath !== metricsAction || healthPath !== healthAction || nativePath !== nativeAction || stopPath !== stopAction || startPath !== startAction) throw new Error("agent route scope rejected");
      const requestPayload = JSON.stringify(body);
      const signature = typeof request.headers["x-deploylite-signature"] === "string" ? request.headers["x-deploylite-signature"] : undefined;
      const result = request.url === "/deployments/receipt" ? await options.receiver.readReceipt(body, signature, controller.signal)
        : request.url === MANAGED_DATABASE_METRICS_PATH ? await options.receiver.observeManagedDatabaseMetrics(body, signature, controller.signal)
        : request.url === MANAGED_DATABASE_HEALTH_PATH ? await options.receiver.observeManagedDatabaseHealth(body, signature, controller.signal)
        : request.url === MANAGED_DATABASE_START_RECEIPT_PATH ? await options.receiver.readManagedDatabaseStartReceipt(body, signature, controller.signal)
        : request.url === MANAGED_DATABASE_STOP_RECEIPT_PATH ? await options.receiver.readManagedDatabaseStopReceipt(body, signature, controller.signal)
        : request.url === MANAGED_DATABASE_RUNTIME_RECEIPT_PATH ? await options.receiver.readManagedDatabaseRuntimeReceipt(body, signature, controller.signal)
        : request.url === DOMAIN_ROUTE_APPLY_RECEIPT_PATH ? await options.receiver.readDomainRouteApplyReceipt(body, signature, controller.signal)
        : request.url === TRANSPORT_PORT_APPLY_RECEIPT_PATH ? await options.receiver.readTransportPortApplyReceipt(body, signature, controller.signal)
        : request.url === COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH ? await options.receiver.readComposeNetworkAttachmentReceipt(body, signature, controller.signal)
        : request.url === COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH ? await options.receiver.readComposeVolumeAttachmentReceipt(body, signature, controller.signal)
        : request.url === COMPOSE_VOLUME_BACKUP_RECEIPT_PATH ? await options.receiver.readComposeVolumeBackupReceipt(body, signature, controller.signal)
        : request.url === COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH ? await options.receiver.readComposeResourceCleanupReceipt(body, signature, controller.signal)
        : request.url === COMPOSE_RESOURCE_INSPECTION_PATH ? await options.receiver.inspectComposeResource(body, signature, controller.signal)
        : await handler(body, { "x-deploylite-signature": signature }, controller.signal);
      const receipt = request.url === "/deployments/receipt" ? agentCachedReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_METRICS_PATH ? managedDatabaseMetricsObservationSchema.parse(result)
        : request.url === MANAGED_DATABASE_HEALTH_PATH ? managedDatabaseHealthObservationSchema.parse(result)
        : request.url === MANAGED_DATABASE_START_RECEIPT_PATH ? managedDatabaseStartCachedReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_STOP_RECEIPT_PATH ? managedDatabaseStopCachedReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_RUNTIME_RECEIPT_PATH ? managedDatabaseRuntimeCachedReceiptSchema.parse(result)
        : request.url === DOMAIN_ROUTE_APPLY_RECEIPT_PATH ? domainRouteApplyCachedReceiptSchema.parse(result)
        : request.url === TRANSPORT_PORT_APPLY_RECEIPT_PATH ? transportPortApplyCachedReceiptSchema.parse(result)
        : request.url === COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH ? composeNetworkAttachmentCachedReceiptSchema.parse(result)
        : request.url === COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH ? composeVolumeAttachmentCachedReceiptSchema.parse(result)
        : request.url === COMPOSE_VOLUME_BACKUP_RECEIPT_PATH ? composeVolumeBackupCachedReceiptSchema.parse(result)
        : request.url === COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH ? composeResourceCleanupCachedReceiptSchema.parse(result)
        : request.url === COMPOSE_RESOURCE_INSPECTION_PATH ? composeResourceInspectionAgentResponseSchema.parse(result)
        : request.url === "/deployments/stop" ? deploymentStopAgentReceiptSchema.parse(result)
        : request.url === COMPOSE_NETWORK_ATTACHMENT_PATH ? composeNetworkAttachmentReceiptSchema.parse(result)
        : request.url === COMPOSE_VOLUME_ATTACHMENT_PATH ? composeVolumeAttachmentReceiptSchema.parse(result)
        : request.url === COMPOSE_VOLUME_BACKUP_PATH ? composeVolumeBackupReceiptSchema.parse(result)
        : request.url === COMPOSE_RESOURCE_CLEANUP_PATH ? composeResourceCleanupExecutionReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_START_PATH ? managedDatabaseStartReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_STOP_PATH ? managedDatabaseStopReceiptSchema.parse(result)
        : request.url === MANAGED_DATABASE_RUNTIME_PATH ? managedDatabaseRuntimeReceiptSchema.parse(result)
        : request.url === DOMAIN_ROUTE_APPLY_PATH ? domainRouteApplyReceiptSchema.parse(result)
        : request.url === TRANSPORT_PORT_APPLY_PATH ? transportPortApplyReceiptSchema.parse(result)
        : agentExecutionReceiptSchema.parse(result);
      if (!response.destroyed) {
        const responsePayload = JSON.stringify(receipt);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (request.url === COMPOSE_RESOURCE_INSPECTION_PATH || request.url === MANAGED_DATABASE_HEALTH_PATH || request.url === MANAGED_DATABASE_METRICS_PATH)
          headers["x-deploylite-response-signature"] = options.receiver.signResponse(`POST ${request.url}\n${requestPayload}\n${responsePayload}`);
        response.writeHead(200, headers).end(responsePayload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "agent command rejected";
      const status = /authentication/.test(message) ? 401 : /capability|scope/.test(message) ? 403 : /expired|conflict|payload/.test(message) ? 409 : 400;
      if (!response.destroyed) response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message.replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]") }));
    } finally { settled = true; active.delete(controller); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); }); });
  return { server, host: options.host, port: options.port, close: async () => { for (const controller of active) controller.abort(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
