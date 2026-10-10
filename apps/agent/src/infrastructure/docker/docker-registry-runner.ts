import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryCredentialKey, type EnvSecretCipher } from '@deploylite/config';
import { registryConfigurationSchema } from '@deploylite/contracts';
import { awaitAbortable, type EnvSecretValueRepository } from '@deploylite/domain';
import type { DockerCliRunner } from './docker-cli-image-transport.js';

type Options = Readonly<{ runner: DockerCliRunner; secrets: EnvSecretValueRepository; cipher?: EnvSecretCipher; trustedHosts: readonly string[] }>;
/** Standalone image runs get a project-scoped private auth file; ambient Docker auth is never copied. */
export function createRegistryDockerRunner(options: Options): DockerCliRunner {
  return { run: async (argv, signal, environment) => {
    if (argv[0] !== 'docker' || argv[1] !== 'run' || !argv.includes('--detach') || !argv.some((value, index) => value === '--label' && argv[index + 1]?.startsWith('com.deploylite.candidate='))) return options.runner.run(argv, signal, environment);
    let directory: string | undefined;
    try {
      if (signal.aborted) throw new Error('Canceled');
      const image = argv.at(-1)!;
      const matched = /^([a-z0-9.-]+(?::[1-9][0-9]{0,4})?)\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.exec(image);
      if (!matched || !options.trustedHosts.includes(matched[1]!)) throw new Error('Untrusted image');
      const projectLabels = argv.flatMap((value, index) => value === '--label' && argv[index + 1]?.startsWith('com.deploylite.project=') ? [argv[index + 1]!.slice('com.deploylite.project='.length)] : []);
      if (projectLabels.length !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(projectLabels[0]!)) throw new Error('Missing project binding');
      const host = matched[1]!, projectId = projectLabels[0]!;
      const rows = await awaitAbortable(() => options.secrets.listEncryptedByProject(projectId), signal);
      const records = rows.filter(row => row.projectId === projectId && row.scope === 'project' && row.key === registryCredentialKey(host));
      if (records.length > 1) throw new Error('Ambiguous credentials');
      const auths: Record<string, { auth: string }> = {};
      if (records[0]) {
        if (!options.cipher) throw new Error('Cipher unavailable');
        const plaintext = options.cipher.decrypt(Buffer.from(records[0].encryptedValue).toString('base64'));
        if (options.cipher.fingerprint(plaintext) !== records[0].valueFingerprint) throw new Error('Stored credential mismatch');
        const config = registryConfigurationSchema.parse(JSON.parse(plaintext));
        if (config.registryHost !== host) throw new Error('Stored registry mismatch');
        if (config.username && config.password) auths[host] = { auth: Buffer.from(`${config.username}:${config.password}`).toString('base64') };
      }
      directory = await mkdtemp(join(tmpdir(), 'deploylite-registry-'));
      await chmod(directory, 0o700);
      await writeFile(join(directory, 'config.json'), JSON.stringify({ auths }), { mode: 0o600, flag: 'wx' });
      if (signal.aborted) throw new Error('Canceled');
      const result = await options.runner.run(['docker', '--config', directory, ...argv.slice(1)], signal, environment);
      if (result.exitCode !== 0 || result.signal !== null || !/^[a-f0-9]{64}\n?$/.test(result.stdout)) throw new Error('Native image run failed');
      return { ...result, stderr: '' };
    } catch { throw new Error('Registry image execution failed safely.'); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  } };
}
