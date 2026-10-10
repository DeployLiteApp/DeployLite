import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { deploymentSchema, transportPortPreviewRequestSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import {
  PolicyEvaluator,
  TransportPortPlanError,
  createTransportPortPlan,
  type AuditRepository,
  type ControlGrantRepository,
  type DeploymentRepository,
  type ProjectRepository,
  type CanonicalRoleName,
  type TransportPortClaimReader
} from "@deploylite/domain";
import { z } from "zod";

type Options = Readonly<{
  prefix: string;
  projects: ProjectRepository;
  deployments: DeploymentRepository;
  claims?: TransportPortClaimReader;
  grants: ControlGrantRepository;
  audit: AuditRepository;
  requireAuth: preHandlerAsyncHookHandler;
  requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown;
  error(request: unknown, code: string, message: string): unknown;
}>;

type TransportPortRequest = FastifyRequest & {
  auth?: { user: { id: string; role: CanonicalRoleName } };
  correlationContext?: { requestId: string; correlationId: string };
};

const paramsSchema = z.object({ projectId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).strict();

/** Read-only TCP/UDP port preview. It never reserves a claim or changes host/runtime state. */
export function registerTransportPortPreviewRoute(app: FastifyInstance, options: Options): void {
  app.post(options.prefix + "/projects/:projectId/transport-ports/preview",
    { preHandler: [options.requireAuth, options.requireRole] },
    async (rawRequest, reply) => {
      const request = rawRequest as TransportPortRequest;
      const auth = request.auth;
      const context = request.correlationContext;
      if (!auth || !context) {
        return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
      }

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      const body = transportPortPreviewRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));

      const projectId = params.data.projectId;
      const audit = async (action: string, metadata: Record<string, unknown> = {}): Promise<boolean> => {
        try {
          await options.audit.append({
            actorUserId: auth.user.id,
            action,
            targetType: "project",
            targetId: projectId,
            requestId: context.requestId,
            correlationId: context.correlationId,
            metadata: {
              projectId,
              deploymentId: body.data.deploymentId,
              protocol: body.data.protocol,
              publishedPort: body.data.publishedPort,
              targetPort: body.data.targetPort,
              ...metadata
            }
          });
          return true;
        } catch {
          return false;
        }
      };
      const unavailable = async (reason: string) => {
        await audit("transport.port.preview.unavailable", { reason });
        return reply.code(503).send(options.error(request, "TRANSPORT_PORT_UNAVAILABLE", "Transport port preview is unavailable."));
      };

      let grants;
      try {
        grants = await options.grants.listForActor(auth.user.id);
      } catch {
        return unavailable("grant-storage-unavailable");
      }
      const decision = new PolicyEvaluator().evaluate({
        actorId: auth.user.id,
        role: auth.user.role,
        action: "project.deploy",
        scope: { kind: "project", projectId },
        correlationId: context.correlationId,
        grants
      });
      if (!decision.allowed) {
        if (!await audit("transport.port.preview.denied", { reason: decision.code })) return unavailable("audit-unavailable");
        return reply.code(403).send(options.error(request, decision.code, "Transport port preview is not authorized."));
      }

      let project;
      try {
        project = await options.projects.findById(projectId);
      } catch {
        return unavailable("project-storage-unavailable");
      }
      if (!project) {
        if (!await audit("transport.port.preview.rejected", { reason: "project-not-found" })) return unavailable("audit-unavailable");
        return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
      }

      let rawDeployment;
      try {
        rawDeployment = await options.deployments.findById(body.data.deploymentId);
      } catch {
        return unavailable("deployment-storage-unavailable");
      }
      if (!rawDeployment) {
        if (!await audit("transport.port.preview.rejected", { reason: "target-not-found" })) return unavailable("audit-unavailable");
        return reply.code(404).send(options.error(request, "NOT_FOUND", "Port target deployment was not found."));
      }
      const parsedDeployment = deploymentSchema.safeParse(rawDeployment);
      if (!parsedDeployment.success) return unavailable("target-state-invalid");
      const deployment = parsedDeployment.data;
      if (deployment.projectId !== projectId) {
        if (!await audit("transport.port.preview.rejected", { reason: "target-project-mismatch" })) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "TRANSPORT_PORT_TARGET_CONFLICT", "Port target is not eligible for this project."));
      }
      const receipt = trustedPriorExecutionReceiptSchema.safeParse(deployment.executionReceipt);
      const targetVerified = receipt.success
        && deployment.status === "succeeded"
        && deployment.finishedAt !== null
        && deployment.snapshotHash !== undefined
        && deployment.snapshotOriginId !== undefined
        && receipt.data.deploymentId === deployment.id
        && receipt.data.projectId === deployment.projectId
        && receipt.data.runtimeHost === deployment.agentId
        && receipt.data.snapshotHash === deployment.snapshotHash
        && receipt.data.snapshotOriginId === deployment.snapshotOriginId;
      if (!targetVerified) {
        if (!await audit("transport.port.preview.rejected", { reason: "target-receipt-unverified" })) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "TRANSPORT_PORT_TARGET_UNVERIFIED", "Port target lacks a matching trusted execution receipt."));
      }

      const claims = options.claims;
      let claimsAvailable = false;
      try { claimsAvailable = claims?.available() === true; } catch { /* fail closed below */ }
      if (!claims || !claimsAvailable) return unavailable("claim-storage-unavailable");

      let plan;
      try {
        const currentClaims = await claims.listClaims();
        plan = createTransportPortPlan({
          desired: {
            schemaVersion: 1,
            projectId,
            deploymentId: deployment.id,
            protocol: body.data.protocol,
            publishedPort: body.data.publishedPort,
            targetPort: body.data.targetPort
          },
          currentClaims
        });
      } catch (error) {
        if (error instanceof TransportPortPlanError) {
          if (error.code === "port-conflict" || error.code === "ambiguous-claims") {
            if (!await audit("transport.port.preview.rejected", { reason: error.code })) return unavailable("audit-unavailable");
            return reply.code(409).send(options.error(request, "TRANSPORT_PORT_CONFLICT", "Protocol and published port conflict with an existing claim."));
          }
          if (error.code === "desired-invalid") {
            if (!await audit("transport.port.preview.rejected", { reason: error.code })) return unavailable("audit-unavailable");
            return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
          }
        }
        return unavailable("claim-state-invalid");
      }

      if (!await audit("transport.port.preview", { action: plan.action })) return unavailable("audit-unavailable");
      return reply.code(200).send(options.ok(request, { plan }));
    });
}
