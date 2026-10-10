import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';
import { expect, it } from 'vitest';
import { transportPortApplyAgentCommandSchema, trustedPriorExecutionReceiptSchema } from '@deploylite/contracts';
import { claimProjectUpdateAuthority, createControlCommand, domainRouteNetworkName } from '@deploylite/domain';
import { createRuntimeTransportPortExecutor } from './docker-transport-port-executor.js';
import { InMemoryEnvSecretValueRepository } from '@deploylite/domain';
import { DockerProcessRunner } from './docker-process-runner.js';
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
    const projectId = 'p4-' + randomUUID(), agentId = 'p4-local', owner = 'deploylite-agent';
    const sourceId = randomUUID(), targetId = randomUUID(), sourceHostPort = await port(), targetHostPort = await port(), publishedPort = await port();
    const binding = { protocol, publishedPort, targetPort: 19132 };
    const routeNetwork = domainRouteNetworkName(projectId); let routeNetworkCreated = false;
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
    const registryRunner = createRegistryDockerRunner({ runner: new DockerProcessRunner(), secrets: new InMemoryEnvSecretValueRepository(), trustedHosts: [image.split('/')[0]!] });
    let failTarget = false; const observations: unknown[] = [];
    const runner = { run: async (argv: readonly string[], signal: AbortSignal) => {
      if (argv[1] === 'run') {
        const name = argv[argv.indexOf('--name') + 1]!; names.add(name);
        if (failTarget && name === `deploylite-active-${sourceId}`) { failTarget = false; return { exitCode: 1, signal: null, stdout: '', stderr: 'injected second replacement failure' }; }
      }
      if (argv[1] === 'rename') names.add(argv[3]!);
      try { const observed = await registryRunner.run(argv, signal); observations.push({ argv, observed }); return observed; } catch (error) { observations.push({ argv, error: { message: (error as Error).message, result: (error as { result?: unknown }).result } }); throw error; }
    } };
    const executor = createRuntimeTransportPortExecutor({ runner, agentId, hostIp: '127.0.0.1' });
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
      expect((await run(['docker', 'network', 'create', '--driver', 'bridge', '--label', 'com.deploylite.owner=deploylite', '--label', `com.deploylite.project=${projectId}`, '--label', 'com.deploylite.kind=domain-route', routeNetwork])).exitCode).toBe(0);
      routeNetworkCreated = true;
      for (const id of [sourceId, targetId]) expect((await run(['docker', 'network', 'connect', routeNetwork, `deploylite-active-${id}`])).exitCode).toBe(0);
      await echo(protocol, publishedPort);
      const first = makeCommand(proof(sourceId, sourceContainer, sourceHostPort), proof(targetId, targetContainer, targetHostPort));
      const result = await executor.execute(first, { assertValid: async () => {} }, new AbortController().signal);
      expect(result, JSON.stringify(observations)).toMatchObject({ state: 'updated', failureReason: null }); await echo(protocol, publishedPort);
      for (const id of [sourceId, targetId]) {
        const networks = await run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', `deploylite-active-${id}`]);
        expect(Object.keys(JSON.parse(networks.stdout))).toContain(routeNetwork);
      }
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
      if (routeNetworkCreated) {
        const labels = await run(['docker', 'network', 'inspect', '--format', '{{json .Labels}}', routeNetwork]);
        expect(JSON.parse(labels.stdout)).toMatchObject({ 'com.deploylite.owner': 'deploylite', 'com.deploylite.project': projectId });
        expect((await run(['docker', 'network', 'rm', routeNetwork])).exitCode).toBe(0);
      }
      const remaining = await run(['docker', 'ps', '-aq', '--filter', `label=com.deploylite.project=${projectId}`]); expect(remaining.stdout.trim()).toBe('');
    }
  }, 120000);
}

it.skipIf(!enabled)('integrates verified domain retarget/rollback, HTTP, WebSocket, ACME issuance/renewal and transport replacement', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const { request: httpsRequest } = await import('node:https'); const { connect: tlsConnect } = await import('node:tls');
  const { createTraefikDomainRouteExecutor } = await import('../traefik/traefik-domain-route-executor.js');
  const { TraefikDomainRouteFileStore } = await import('../traefik/traefik-domain-route-file-store.js');
  const { domainRouteApplyAgentCommandSchema } = await import('@deploylite/contracts');
  const projectId = 'p4-' + randomUUID(), agentId = 'p4-local', owner = 'deploylite-agent';
  const a = randomUUID(), b = randomUUID(), aPort = await port(), bPort = await port(), tlsPort = await port(), managementPort = await port();
  const primaryNetwork = 'p4-acme-' + randomUUID(), routeNetwork = domainRouteNetworkName(projectId);
  const traefikName = 'deploylite-traefik-' + String(Math.floor(Math.random() * 1e9) + 1), pebbleName = 'p4-pebble-' + randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'deploylite-p4-integrated-')), dynamic = join(directory, 'dynamic');
  const { mkdir } = await import('node:fs/promises'); await mkdir(dynamic); await writeFile(join(directory, 'acme.json'), '', { mode: 0o600 });
  const ca = await readFile(resolve('../../infra/acme-test/pebble.minica.pem'));
  const native = new DockerProcessRunner();
  const registry = createRegistryDockerRunner({ runner: native, secrets: new InMemoryEnvSecretValueRepository(), trustedHosts: [image.split('/')[0]!] });
  const names = new Set<string>([pebbleName, traefikName, `deploylite-active-${a}`, `deploylite-active-${b}`]);
  let primaryCreated = false; const signal = new AbortController().signal;
  const commandRunner = { run: async (argv: readonly string[], abort: AbortSignal) => {
    if (argv[1] === 'container' && argv[2] === 'ls') throw new Error('Fixture requires its explicit owned Traefik ID');
    if (argv[1] === 'run') names.add(argv[argv.indexOf('--name') + 1]!);
    if (argv[1] === 'rename') names.add(argv[3]!);
    return registry.run(argv, abort);
  } };
  const inspectId = async (id: string) => (await run(['docker', 'inspect', '--format', '{{.Id}}', `deploylite-active-${id}`])).stdout.trim();
  const proof = (id: string, containerId: string, hostPort: number) => trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1,
    candidateId: `${id}:candidate:fixture`, deploymentId: id, projectId, snapshotOriginId: id, snapshotHash: 'a'.repeat(64),
    effectiveImageDigest: image.split('@')[1], runtimeHost: agentId, container: `deploylite-active-${id}`, containerId,
    hostPort, containerPort: 3000, network: null });
  const http = (root?: Buffer) => new Promise<{ body: string; serial: string }>((resolveResult, reject) => {
    const request = httpsRequest({ agent: false, hostname: '127.0.0.1', port: tlsPort, servername: 'acme.test', ca: root, headers: { host: 'acme.test' }, timeout: 3000 }, response => {
      let body = ''; const socket = response.socket as import('node:tls').TLSSocket; const serial = socket.getPeerCertificate().serialNumber;
      response.on('data', bytes => { body += bytes.toString(); }); response.on('end', () => response.statusCode === 200 ? resolveResult({ body, serial }) : reject(new Error('HTTP route unavailable')));
    }); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('HTTP timeout'))); request.end();
  });
  const ws = (root: Buffer) => new Promise<string>((resolveResult, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: tlsPort, servername: 'acme.test', ca: root }, () => socket.write('GET / HTTP/1.1\r\nHost: acme.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: cDQtaW50ZWdyYXRlZC10ZXN0\r\n\r\n'));
    let bytes = Buffer.alloc(0); socket.setTimeout(3000, () => socket.destroy(new Error('WS timeout'))); socket.on('error', reject);
    socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf('\r\n\r\n'); if (end < 0 || bytes.length < end + 6) return;
      const headers = bytes.subarray(0, end).toString(); if (!headers.startsWith('HTTP/1.1 101')) { socket.destroy(); reject(new Error('WS upgrade rejected')); return; }
      const frame = bytes.subarray(end + 4), length = frame[1]! & 127; if (bytes.length < end + 6 + length) return;
      socket.end(); resolveResult(frame.subarray(2, 2 + length).toString());
    });
  });
  async function eventually<T>(operation: () => Promise<T>, predicate: (value: T) => boolean, timeout = 45000): Promise<T> {
    const until = Date.now() + timeout; let value: T | undefined;
    while (Date.now() < until) { try { value = await operation(); if (predicate(value)) return value; } catch {} await new Promise(r => setTimeout(r, 200)); }
    throw new Error('Integrated runtime observation timed out');
  }
  try {
    expect((await run(['docker', 'network', 'create', '--label', `com.deploylite.project=${projectId}`, primaryNetwork])).exitCode).toBe(0); primaryCreated = true;
    const pebble = await run(['docker', 'run', '--detach', '--name', pebbleName, '--label', `com.deploylite.project=${projectId}`, '--network', primaryNetwork, '--network-alias', 'pebble',
      '-p', `127.0.0.1:${managementPort}:15000`, '-e', 'PEBBLE_VA_NOSLEEP=1', '--mount', `type=bind,src=${resolve('../../infra/acme-test/pebble-config.json')},dst=/test/pebble-config.json,readonly`,
      'ghcr.io/letsencrypt/pebble:2.7.0@sha256:c156cabea562e43ed0060bddc03539c07de40e311b52c6b0e5ea710a496e56b8', '-config', '/test/pebble-config.json', '-strict']); expect(pebble.exitCode, pebble.stderr).toBe(0);
    const root = await eventually(() => new Promise<Buffer>((resolveResult, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: managementPort, servername: 'pebble', ca, path: '/roots/0', timeout: 3000 }, response => {
        const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => resolveResult(Buffer.concat(chunks)));
      }); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Management timeout'))); request.end();
    }), value => value.toString().includes('BEGIN CERTIFICATE'));
    const traefik = await run(['docker', 'run', '--detach', '--name', traefikName, '--label', `com.deploylite.project=${projectId}`, '--label', 'com.docker.compose.project=deploylite', '--label', 'com.docker.compose.service=traefik',
      '--network', primaryNetwork, '--network-alias', 'acme.test', '-p', `127.0.0.1:${tlsPort}:443`, '--mount', `type=bind,src=${dynamic},dst=/dynamic`,
      '--mount', `type=bind,src=${directory},dst=/acme`, '--mount', `type=bind,src=${resolve('../../infra/acme-test/pebble.minica.pem')},dst=/test-ca.pem,readonly`,
      'traefik:v3.6.7@sha256:a9890c898f379c1905ee5b28342f6b408dc863f08db2dab20e46c267d1ff463a', '--entrypoints.websecure.address=:443', '--providers.file.directory=/dynamic', '--providers.file.watch=true',
      '--certificatesresolvers.le.acme.caserver=https://pebble:14000/dir', '--certificatesresolvers.le.acme.email=p4-fixture@example.invalid', '--certificatesresolvers.le.acme.storage=/acme/acme.json',
      '--certificatesresolvers.le.acme.tlschallenge=true', '--certificatesresolvers.le.acme.certificatesduration=1', '--certificatesresolvers.le.acme.cacertificates=/test-ca.pem']); expect(traefik.exitCode, traefik.stderr).toBe(0);
    for (const [id, hostPort] of [[a, aPort], [b, bPort]] as const) {
      const argv = buildDockerTransportPortRunArgv({ candidate: { candidateId: `${id}:candidate:fixture`, deploymentId: id, projectId, effectiveImage: image, runtimePort: 3000 }, projectId,
        containerName: `deploylite-active-${id}`, owner, hostPort, containerPort: 3000, allowedNetworks: [], hostIp: '127.0.0.1', bindings: [] }); expect((await registry.run(argv, signal)).exitCode).toBe(0);
      await eventually(async () => (await run(['docker', 'inspect', '--format', '{{.State.Health.Status}}', `deploylite-active-${id}`])).stdout.trim(), value => value === 'healthy');
    }
    const aProof = proof(a, await inspectId(a), aPort), bProof = proof(b, await inspectId(b), bPort);
    const routes = createTraefikDomainRouteExecutor({ runner: commandRunner, fileStore: new TraefikDomainRouteFileStore(dynamic), agentId, traefikContainerId: traefik.stdout.trim() });
    const applyRoute = async (executionReceipt: typeof aProof) => {
      const route = { schemaVersion: 1, projectId, deploymentId: executionReceipt.deploymentId, domain: 'acme.test' };
      const control = { ...createControlCommand({ actorId: 'p4-actor', action: 'project.update', scope: { kind: 'project', projectId }, input: { route, executionReceipt, effectiveImage: image }, idempotencyKey: randomUUID(), correlationId: randomUUID(), expiresAt: new Date(Date.now() + 120000) }), status: 'eligible' as const };
      const authority = claimProjectUpdateAuthority([control], control, Date.now())!;
      const command = domainRouteApplyAgentCommandSchema.parse({ schemaVersion: 1, action: 'domain.route.apply', agentId, commandId: control.id, projectId, idempotencyKey: control.idempotencyKey,
        inputDigest: control.inputDigest, route, executionReceipt, effectiveImage: image, requiredCapabilities: ['traefik.domain.route.apply.v1'], authority, lease: authority.projectLease,
        context: { requestId: randomUUID(), correlationId: control.correlationId }, timeoutMs: 30000, cancellationRequested: false });
      const result = await routes.execute(command, { assertValid: async () => {} }, signal); expect(['created', 'updated', 'unchanged'], JSON.stringify(result)).toContain(result.state);
    };
    await applyRoute(aProof); const initial = await eventually(() => http(root), value => value.body.includes(aProof.containerId.slice(0, 12)));
    expect(await ws(root)).toBe('p4-websocket:' + aProof.containerId.slice(0, 12));
    await applyRoute(bProof); await eventually(() => http(root), value => value.body.includes(bProof.containerId.slice(0, 12))); expect(await ws(root)).toContain(bProof.containerId.slice(0, 12));
    await applyRoute(aProof); await eventually(() => http(root), value => value.body.includes(aProof.containerId.slice(0, 12)));
    const udpPort = await port(), route = { schemaVersion: 1, projectId, deploymentId: a, protocol: 'udp', publishedPort: udpPort, targetPort: 19132 };
    const control = { ...createControlCommand({ actorId: 'p4-actor', action: 'project.update', scope: { kind: 'project', projectId }, input: { route, executionReceipt: aProof, effectiveImage: image, operation: 'apply', rollbackRevisionId: null }, idempotencyKey: randomUUID(), correlationId: randomUUID(), expiresAt: new Date(Date.now() + 120000) }), status: 'eligible' as const };
    const authority = claimProjectUpdateAuthority([control], control, Date.now())!;
    const command = transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: 'transport.port.apply', agentId, commandId: control.id, projectId, idempotencyKey: control.idempotencyKey,
      inputDigest: control.inputDigest, operation: 'apply', rollbackRevisionId: null, route, currentContainerId: aProof.containerId, bindings: [{ protocol: 'udp', publishedPort: udpPort, targetPort: 19132 }], previousBindings: [], executionReceipt: aProof,
      effectiveImage: image, requiredCapabilities: ['docker.transport.port.apply.v1'], authority, lease: authority.projectLease, context: { requestId: randomUUID(), correlationId: control.correlationId }, timeoutMs: 30000, cancellationRequested: false });
    const replacement = await createRuntimeTransportPortExecutor({ runner: commandRunner, agentId, hostIp: '127.0.0.1' }).execute(command, { assertValid: async () => {} }, signal);
    expect(replacement.state, JSON.stringify(replacement)).toBe('updated'); await echo('udp', udpPort);
    await applyRoute({ ...aProof, containerId: replacement.containerId! });
    await eventually(() => http(root), value => value.body.includes(replacement.containerId!.slice(0, 12)), 15000); expect(await ws(root)).toContain(replacement.containerId!.slice(0, 12));
    expect((await run(['docker', 'restart', traefikName])).exitCode).toBe(0);
    const renewed = await eventually(() => http(root), value => value.serial !== initial.serial && value.body.includes(replacement.containerId!.slice(0, 12)), 60000);
    expect(initial.serial).toMatch(/^[A-Fa-f0-9]+$/); expect(renewed.serial).toMatch(/^[A-Fa-f0-9]+$/);
    expect(renewed.serial).not.toBe(initial.serial);
  } catch (error) {
    const diagnostics = await native.run(['docker', 'logs', '--tail', '30', traefikName], signal);
    throw new Error(String(error) + '\n' + diagnostics.stdout + diagnostics.stderr);
  } finally {
    for (const name of names) {
      const labels = await run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.deploylite.project"}}', name]);
      if (labels.exitCode === 0) { expect(labels.stdout.trim()).toBe(projectId); expect((await run(['docker', 'rm', '--force', name])).exitCode).toBe(0); }
    }
    const network = await run(['docker', 'network', 'inspect', '--format', '{{index .Labels "com.deploylite.project"}}', routeNetwork]);
    if (network.exitCode === 0) { expect(network.stdout.trim()).toBe(projectId); expect((await run(['docker', 'network', 'rm', routeNetwork])).exitCode).toBe(0); }
    if (primaryCreated) expect((await run(['docker', 'network', 'rm', primaryNetwork])).exitCode).toBe(0);
    expect((await run(['docker', 'ps', '-aq', '--filter', `label=com.deploylite.project=${projectId}`])).stdout.trim()).toBe('');
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
