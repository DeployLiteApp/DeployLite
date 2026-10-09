import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { deploymentSchema, domainRoutePreviewRequestSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import {
  DomainRoutePlanError,
  PolicyEvaluator,
  createDomainRoutePlan,
  type AuditRepository,
  type ControlGrantRepository,
  type DeploymentRepository,
  type DomainRouteClaimReader,
  type ProjectRepository,
  type CanonicalRoleName
} from "@deploylite/domain";
import { z } from "zod";

type Options = Readonly<{
  prefix: string;
  projects: ProjectRepository;
  deployments: DeploymentRepository;
  domainRouteClaims?: DomainRouteClaimReader;
  grants: ControlGrantRepository;
  audit: AuditRepository;
  requireAuth: preHandlerAsyncHookHandler;
  requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown;
  error(request: unknown, code: string, message: string): unknown;
}>;

type DomainRouteRequest = FastifyRequest & {
  auth?: { user: { id: string; role: CanonicalRoleName } };
  correlationContext?: { requestId: string; correlationId: string };
};

const paramsSchema = z.object({ projectId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).strict();

/** Read-only route preview. It never persists a claim or changes proxy/runtime state. */
export function registerDomainRoutePreviewRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/domains/preview`,
    { preHandler: [options.requireAuth, options.requireRole] },
    async (rawRequest, reply) => {
      const request = rawRequest as DomainRouteRequest;
      const auth = request.auth;
      const context = request.correlationContext;
      if (!auth || !context) {
        return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
      }

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      }
      const body = domainRoutePreviewRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      }

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
            metadata: { projectId, domain: body.data.domain, deploymentId: body.data.deploymentId, ...metadata }
          });
          return true;
        } catch {
          return false;
        }
      };
      const unavailable = async (reason: string) => {
        await audit("domain.route.preview.unavailable", { reason });
        return reply.code(503).send(options.error(request, "DOMAIN_ROUTE_UNAVAILABLE", "Domain route preview is unavailable."));
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
        if (!await audit("domain.route.preview.denied", { reason: decision.code })) return unavailable("audit-unavailable");
        return reply.code(403).send(options.error(request, decision.code, "Domain route preview is not authorized."));
      }

      let project;
      try {
        project = await options.projects.findById(projectId);
      } catch {
        return unavailable("project-storage-unavailable");
      }
      if (!project) {
        if (!await audit("domain.route.preview.rejected", { reason: "project-not-found" })) return unavailable("audit-unavailable");
        return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
      }

      let rawDeployment;
      try {
        rawDeployment = await options.deployments.findById(body.data.deploymentId);
      } catch {
        return unavailable("deployment-storage-unavailable");
      }
      if (!rawDeployment) {
        if (!await audit("domain.route.preview.rejected", { reason: "target-not-found" })) return unavailable("audit-unavailable");
        return reply.code(404).send(options.error(request, "NOT_FOUND", "Route target deployment was not found."));
      }
      const parsedDeployment = deploymentSchema.safeParse(rawDeployment);
      if (!parsedDeployment.success) return unavailable("target-state-invalid");
      const deployment = parsedDeployment.data;
      if (deployment.projectId !== projectId) {
        if (!await audit("domain.route.preview.rejected", { reason: "target-project-mismatch" })) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_CONFLICT", "Route target is not eligible for this project."));
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
        if (!await audit("domain.route.preview.rejected", { reason: "target-receipt-unverified" })) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_UNVERIFIED", "Route target lacks a matching trusted execution receipt."));
      }

      const claims = options.domainRouteClaims;
      let claimsAvailable = false;
      try { claimsAvailable = claims?.available() === true; } catch { /* fail closed below */ }
      if (!claims || !claimsAvailable) return unavailable("claim-storage-unavailable");

      let plan;
      try {
        const currentClaims = await claims.listClaims();
        plan = createDomainRoutePlan({
          desired: { schemaVersion: 1, projectId, deploymentId: deployment.id, domain: body.data.domain },
          currentClaims
        });
      } catch (error) {
        if (error instanceof DomainRoutePlanError) {
          if (error.code === "domain-conflict" || error.code === "ambiguous-claims") {
            if (!await audit("domain.route.preview.rejected", { reason: error.code })) return unavailable("audit-unavailable");
            return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_CONFLICT", "Domain ownership conflicts with an existing route claim."));
          }
          if (error.code === "desired-invalid") {
            if (!await audit("domain.route.preview.rejected", { reason: error.code })) return unavailable("audit-unavailable");
            return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
          }
        }
        return unavailable("claim-state-invalid");
      }

      if (!await audit("domain.route.preview", { action: plan.action })) return unavailable("audit-unavailable");
      return reply.code(200).send(options.ok(request, { plan }));
    });
}
