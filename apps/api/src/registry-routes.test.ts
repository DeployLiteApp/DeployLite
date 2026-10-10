import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createEnvSecretCipher } from '@deploylite/config';
import { InMemoryEnvSecretValueRepository } from '@deploylite/domain';
import { registerRegistryRoutes } from './registry-routes.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
async function fixture(allowed = true, auditFails = false) {
  const app = Fastify(); apps.push(app); const secrets = new InMemoryEnvSecretValueRepository(); const audits: unknown[] = [];
  const cipher = createEnvSecretCipher(Buffer.from('ab'.repeat(32), 'hex'));
  registerRegistryRoutes(app, { prefix: '/api/v1', projects: { findById: async (id: string) => id === 'project-1' ? { id, name: 'fixture', repoUrl: 'https://github.com/example/fixture', defaultBranch: 'main', buildCommand: null, runCommand: null, port: null, description: null, imageTag: null } : null },
    secrets, cipher, trustedHosts: ['registry.example.com'], grants: { listForActor: async () => allowed ? [{ id: 'grant', actorId: 'actor', action: 'project.update', scope: { kind: 'project', projectId: 'project-1' } }] : [] },
    audit: { append: async (event: unknown) => { if (auditFails) throw new Error('audit unavailable'); audits.push(event); return event as never; } },
    requireAuth: async (r: unknown) => { Object.assign(r as object, { auth: { user: { id: 'actor', role: 'operator' } }, correlationContext: { requestId: 'request', correlationId: 'correlation' } }); },
    requireRole: async () => {}, ok: (_r: unknown, data: unknown) => ({ data, error: null }), error: (_r: unknown, code: string) => ({ data: null, error: { code } })
  });
  return { app, secrets, audits, put: (payload: Record<string, unknown>, project = 'project-1') => app.inject({ method: 'PUT', url: `/api/v1/projects/${project}/registries`, payload }) };
}
it('encrypts application registry credentials and returns only redacted configuration on save/read', async () => {
  const f = await fixture(); const secret = 'p4-registry-canary-password';
  const response = await f.put({ registryHost: 'registry.example.com', username: 'fixture-user', password: secret }); expect(response.statusCode).toBe(200);
  const rows = await f.secrets.listEncryptedByProject('project-1'); expect(rows).toHaveLength(1);
  expect(Buffer.from(rows[0]!.encryptedValue).toString()).not.toContain(secret);
  const read = await f.app.inject({ method: 'GET', url: '/api/v1/projects/project-1/registries' }); expect(read.statusCode).toBe(200);
  expect(read.json().data.registries).toEqual([{ registryHost: 'registry.example.com', authenticationConfigured: true }]);
  expect(response.body + read.body + JSON.stringify(f.audits)).not.toContain(secret);
  expect(response.body + read.body + JSON.stringify(f.audits)).not.toContain('fixture-user');
});
it('supports public registry without credentials and rotation to public', async () => {
  const f = await fixture(); expect((await f.put({ registryHost: 'registry.example.com', username: 'user', password: 'token' })).statusCode).toBe(200);
  expect((await f.put({ registryHost: 'registry.example.com' })).statusCode).toBe(200);
  const read = await f.app.inject({ method: 'GET', url: '/api/v1/projects/project-1/registries' });
  expect(read.json().data.registries).toEqual([{ registryHost: 'registry.example.com', authenticationConfigured: false }]);
});
it('rejects untrusted hosts, URL credentials and incomplete authentication without persisting', async () => {
  const f = await fixture();
  for (const payload of [{ registryHost: 'foreign.example.com' }, { registryHost: 'https://user:token@registry.example.com' }, { registryHost: 'registry.example.com', username: 'user' }]) expect((await f.put(payload)).statusCode).toBe(400);
  expect(await f.secrets.listEncryptedByProject('project-1')).toEqual([]);
});
it('requires project.update before reading or saving registry secrets', async () => {
  const f = await fixture(false); expect((await f.put({ registryHost: 'registry.example.com' })).statusCode).toBe(403);
  const response = await f.app.inject({ method: 'GET', url: '/api/v1/projects/project-1/registries' }); expect(response.statusCode).toBe(403);
  expect(await f.secrets.listEncryptedByProject('project-1')).toEqual([]);
});
it('fails closed when required audit is unavailable or project is foreign', async () => {
  const f = await fixture(true, true); expect((await f.put({ registryHost: 'registry.example.com' })).statusCode).toBe(503);
  expect(await f.secrets.listEncryptedByProject('project-1')).toEqual([]);
  const other = await fixture(); expect((await other.put({ registryHost: 'registry.example.com' }, 'project-2')).statusCode).toBe(403);
});
