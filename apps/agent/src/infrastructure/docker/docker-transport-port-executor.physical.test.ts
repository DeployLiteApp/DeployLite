import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';
import { expect, it } from 'vitest';
import { transportPortApplyAgentCommandSchema, trustedPriorExecutionReceiptSchema } from '@deploylite/contracts';
import { claimProjectUpdateAuthority, createControlCommand } from '@deploylite/domain';
import { DockerTransportPortExecutor } from './docker-transport-port-executor.js';
import { InMemoryEnvSecretValueRepository } from '@deploylite/domain';
import { createRegistryDockerRunner } from './docker-registry-runner.js';
import { buildDockerTransportPortRunArgv } from './docker-cli-argv.js';

const enabled = process.env.DEPLOYLITE_P4_PHYSICAL === '1';
const exec = promisify(execFile);
const image = process.env.DEPLOYLITE_P4_FIXTURE_IMAGE ?? '';
async function run(argv: readonly string[], signal = new AbortController().signal) {
  try { const result = await exec(argv[0]!, [...argv.slice(1)], { signal, timeout: 30000 }); return { exitCode: 0, signal: null, ...result }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof e.code === 'number' ? e.code : 1, signal: null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
}
async function port() {
  const s = net.createServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const value = (s.address() as net.AddressInfo).port; await new Promise<void>(resolve => s.close(() => resolve())); return value;
}
async function echo(protocol: 'tcp' | 'udp', publishedPort: number) {
  const marker = 'p4-physical-' + randomUUID();
  if (protocol === 'tcp') return new Promise<string>((resolve, reject) => {
    const socket = net.connect(publishedPort, '127.0.0.1', () => socket.write(marker));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('TCP probe timeout')); });
    socket.once('error', reject); socket.once('data', b => { socket.end(); resolve(b.toString()); });
  }).then(result => expect(result).toBe(marker));
  return new Promise<string>((resolve, reject) => {
    const socket = dgram.createSocket('udp4'); const timer = setTimeout(() => { socket.close(); reject(new Error('UDP probe timeout')); }, 3000);
    socket.once('error', e => { clearTimeout(timer); socket.close(); reject(e); });
    socket.once('message', b => { clearTimeout(timer); socket.close(); resolve(b.toString()); });
    socket.send(marker, publishedPort, '127.0.0.1');
  }).then(result => expect(result).toBe(marker));
}

for (const protocol of ['tcp', 'udp'] as const) {
  it.skipIf(!enabled)(`physically transfers ${protocol}, rejects stale replay, rolls back and restores both originals on failed cutover`, async () => {
    if (!/^localhost:[0-9]+\/deploylite-p4-fixture@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Explicit loopback fixture digest required');
    const projectId = 'p4-' + randomUUID(), agentId = 'p4-local', owner = 'p4-physical-20261010';
    const sourceId = randomUUID(), targetId = randomUUID(), sourceHostPort = await port(), targetHostPort = await port(), publishedPort = await port();
    const binding = { protocol, publishedPort, targetPort: 19132 };
    const names = new Set<string>([`deploylite-active-${sourceId}`, `deploylite-active-${targetId}`]);
    const proof = (id: string, containerId: string, hostPort: number) => trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1,
      candidateId: `${id}:candidate:fixture`, deploymentId: id, projectId, snapshotOriginId: id, snapshotHash: 'a'.repeat(64),
      effectiveImageDigest: image.split('@')[1], runtimeHost: agentId, container: `deploylite-active-${id}`, containerId,
      hostPort, containerPort: 3000, network: null });
    const start = async (id: string, hostPort: number, bindings: typeof binding[]) => {
      const argv = buildDockerTransportPortRunArgv({ candidate: { candidateId: `${id}:candidate:fixture`, deploymentId: id, projectId,
        effectiveImage: image, runtimePort: 3000 }, projectId, containerName: `deploylite-active-${id}`, owner, hostPort,
        containerPort: 3000, allowedNetworks: [], hostIp: '127.0.0.1', bindings });
      const result = await run(argv); expect(result.exitCode, result.stderr).toBe(0); return result.stdout.trim();
    };
    const inspect = async (id: string) => {
      const r = await run(['docker', 'inspect', '--format', '{{.Id}}|{{.State.Health.Status}}', `deploylite-active-${id}`]);
      expect(r.exitCode, r.stderr).toBe(0); return r.stdout.trim().split('|');
    };
    const registryRunner = createRegistryDockerRunner({ runner: { run }, secrets: new InMemoryEnvSecretValueRepository(), trustedHosts: [image.split('/')[0]!] });
    let failTarget = false; const observations: unknown[] = [];
    const runner = { run: async (argv: readonly string[], signal: AbortSignal) => {
      if (argv[1] === 'run') {
        const name = argv[argv.indexOf('--name') + 1]!; names.add(name);
        if (failTarget && name === `deploylite-active-${sourceId}`) { failTarget = false; return { exitCode: 1, signal: null, stdout: '', stderr: 'injected second replacement failure' }; }
      }
      if (argv[1] === 'rename') names.add(argv[3]!);
      const observed = await registryRunner.run(argv, signal); observations.push({ argv, observed }); return observed;
    } };
    const executor = new DockerTransportPortExecutor({ runner, agentId, owner, hostIp: '127.0.0.1' });
    const makeCommand = (from: ReturnType<typeof proof>, to: ReturnType<typeof proof>, rollback = false) => {
      const route = { schemaVersion: 1, projectId, deploymentId: to.deploymentId, ...binding };
      const portTransfer = { sourceDeploymentId: from.deploymentId, sourceContainerId: from.containerId, sourceBindings: [],
        sourcePreviousBindings: [binding], sourceExecutionReceipt: from, sourceEffectiveImage: image };
      const operation = rollback ? 'rollback' : 'apply', rollbackRevisionId = rollback ? randomUUID() : null;
      const now = Date.now(); const control = { ...createControlCommand({ actorId: 'p4-actor', action: 'project.update', scope: { kind: 'project', projectId },
        input: { route, executionReceipt: to, effectiveImage: image, operation, rollbackRevisionId, portTransfer }, idempotencyKey: randomUUID(),
        correlationId: randomUUID(), expiresAt: new Date(now + 120000) }), status: 'eligible' as const };
      const authority = claimProjectUpdateAuthority([control], control, now)!;
      return transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: 'transport.port.apply', agentId, commandId: control.id, projectId,
        idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest, operation, rollbackRevisionId, route,
        currentContainerId: to.containerId, bindings: [binding], previousBindings: [], portTransfer, executionReceipt: to, effectiveImage: image,
        requiredCapabilities: ['docker.transport.port.apply.v1', 'docker.transport.port.transfer.v1'], authority, lease: authority.projectLease,
        context: { requestId: randomUUID(), correlationId: control.correlationId }, timeoutMs: 30000, cancellationRequested: false });
    };
    try {
      const sourceContainer = await start(sourceId, sourceHostPort, [binding]), targetContainer = await start(targetId, targetHostPort, []);
      for (let i = 0; i < 100; i++) { if ((await inspect(sourceId))[1] === 'healthy' && (await inspect(targetId))[1] === 'healthy') break; await new Promise(r => setTimeout(r, 100)); }
      await echo(protocol, publishedPort);
      const first = makeCommand(proof(sourceId, sourceContainer, sourceHostPort), proof(targetId, targetContainer, targetHostPort));
      const result = await executor.execute(first, { assertValid: async () => {} }, new AbortController().signal);
      expect(result, JSON.stringify(observations)).toMatchObject({ state: 'updated', failureReason: null }); await echo(protocol, publishedPort);
      expect((await inspect(sourceId))[0]).toBe(result.portTransfer?.sourceContainerId);
      expect((await inspect(targetId))[0]).toBe(result.containerId);
      const replay = await executor.execute(first, { assertValid: async () => {} }, new AbortController().signal);
      expect(replay).toMatchObject({ state: 'failed', failureReason: 'target-unavailable' });
      expect((await inspect(targetId))[0]).toBe(result.containerId);
      const back = makeCommand(proof(targetId, result.containerId!, targetHostPort), proof(sourceId, result.portTransfer!.sourceContainerId, sourceHostPort), true);
      const rollback = await executor.execute(back, { assertValid: async () => {} }, new AbortController().signal);
      expect(rollback).toMatchObject({ state: 'updated', operation: 'rollback' }); await echo(protocol, publishedPort);
      const originalSource = (await inspect(sourceId))[0]!, originalTarget = (await inspect(targetId))[0]!;
      failTarget = true;
      const failed = await executor.execute(makeCommand(proof(sourceId, originalSource, sourceHostPort), proof(targetId, originalTarget, targetHostPort)),
        { assertValid: async () => {} }, new AbortController().signal);
      expect(failed.state).toBe('failed');
      expect(await inspect(sourceId)).toEqual([originalSource, 'healthy']); expect(await inspect(targetId)).toEqual([originalTarget, 'healthy']);
      await echo(protocol, publishedPort);
    } finally {
      for (const name of names) {
        const identity = await run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.deploylite.owner"}}', name]);
        if (identity.exitCode === 0) { expect(identity.stdout.trim()).toBe(owner); expect((await run(['docker', 'rm', '--force', name])).exitCode).toBe(0); }
      }
      const remaining = await run(['docker', 'ps', '-aq', '--filter', `label=com.deploylite.project=${projectId}`]); expect(remaining.stdout.trim()).toBe('');
    }
  }, 120000);
}
