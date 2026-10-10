import { readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEnvSecretCipher } from '@deploylite/config';
import { InMemoryEnvSecretValueRepository } from '@deploylite/domain';
import { createHash } from 'node:crypto';
import { createRegistryDockerRunner } from './docker-registry-runner.js';
const image = 'registry.example.com/app@sha256:' + 'a'.repeat(64);
const argv = ['docker', 'run', '--detach', '--label', 'com.deploylite.project=project-1', image];
const key = 'DEPLOYLITE_REGISTRY_' + createHash('sha256').update('registry.example.com').digest('hex').toUpperCase();
async function fixture() {
  const secrets = new InMemoryEnvSecretValueRepository(), cipher = createEnvSecretCipher(Buffer.alloc(32, 7));
  const plaintext = JSON.stringify({ registryHost: 'registry.example.com', username: 'fixture-user', password: 'fixture-canary' });
  await secrets.upsert({ projectId: 'project-1', key, scope: 'project', encryptedValue: Buffer.from(cipher.encrypt(plaintext), 'base64'), valueFingerprint: cipher.fingerprint(plaintext), keyVersion: 1 });
  return { secrets, cipher };
}
it('uses only encrypted same-project registry credentials in a private temporary config and removes it', async () => {
  const f = await fixture(); let directory = '';
  const runner = { run: vi.fn(async (args: readonly string[]) => {
    expect(args.slice(0, 3)).toEqual(['docker', '--config', expect.any(String)]); directory = args[2]!;
    expect((await stat(directory)).mode & 0o777).toBe(0o700); expect((await stat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    expect(config).toEqual({ auths: { 'registry.example.com': { auth: Buffer.from('fixture-user:fixture-canary').toString('base64') } } });
    expect(args.join(' ')).not.toContain('fixture-canary'); return { exitCode: 0, signal: null, stdout: 'b'.repeat(64), stderr: '' };
  }) };
  await createRegistryDockerRunner({ ...f, runner, trustedHosts: ['registry.example.com'] }).run(argv, new AbortController().signal);
  await expect(access(directory)).rejects.toThrow(); expect(runner.run).toHaveBeenCalledOnce();
});
it('isolates public registries from ambient authentication and other project credentials', async () => {
  const f = await fixture(); const runner = { run: vi.fn(async (args: readonly string[]) => {
    expect(args[1]).toBe('--config'); expect(JSON.parse(await readFile(join(args[2]!, 'config.json'), 'utf8'))).toEqual({ auths: {} });
    return { exitCode: 0, signal: null, stdout: 'b'.repeat(64), stderr: '' };
  }) };
  await createRegistryDockerRunner({ ...f, runner, trustedHosts: ['registry.example.com'] }).run(argv.map(s => s.replace('project-1', 'project-2')), new AbortController().signal);
});
it('rejects untrusted images and missing project binding before invoking Docker', async () => {
  const f = await fixture(); const runner = { run: vi.fn() };
  const adapter = createRegistryDockerRunner({ ...f, runner, trustedHosts: ['registry.example.com'] });
  await expect(adapter.run(['docker', 'run', image], new AbortController().signal)).rejects.toThrow();
  await expect(adapter.run(argv.map(s => s.replace('registry.example.com', 'foreign.example.com')), new AbortController().signal)).rejects.toThrow(); expect(runner.run).not.toHaveBeenCalled();
});
it('redacts native credential output and removes temporary config even when native runner fails', async () => {
  const f = await fixture(); let directory = ''; const runner = { run: vi.fn(async (args: readonly string[]) => {
    directory = args[2]!; throw new Error('fixture-canary');
  }) };
  const adapter = createRegistryDockerRunner({ ...f, runner, trustedHosts: ['registry.example.com'] });
  await expect(adapter.run(argv, new AbortController().signal)).rejects.toThrow('Registry image execution failed safely.');
  await expect(access(directory)).rejects.toThrow();
});
