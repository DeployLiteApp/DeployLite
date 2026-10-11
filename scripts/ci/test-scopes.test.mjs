import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { excludedPhysicalTestFiles } from './test-scopes.mjs';
const files = {
  db: ['src/postgres.integration.test.ts', 'src/compose-postgres.integration.test.ts'],
  api: ['src/postgres.integration.test.ts', 'src/compose-resource-docker.integration.test.ts'],
  agent: ['src/infrastructure/docker/docker-transport-port-executor.physical.test.ts']
};
test('ordinary unit collection cannot accidentally load actual DB or Docker suites', () => {
  for (const workspace of Object.keys(files)) {
    const excluded = excludedPhysicalTestFiles(workspace, {});
    for (const path of files[workspace]) assert(excluded.includes(path));
    assert(!excluded.includes('src/server.test.ts'));
    assert(!excluded.includes('src/deployment-docker.integration.test.ts')); // All 74 mocked guards stay in unit collection.
    assert(!excluded.includes('src/infrastructure/docker/docker-redaction-integration.test.ts'));
  }
});
test('every dedicated job collects its original physical files under its existing explicit flag', () => {
  for (const [workspace, flag, selected] of [
    ['db', 'DEPLOYLITE_DB_INTEGRATION', files.db],
    ['api', 'DEPLOYLITE_API_POSTGRES_INTEGRATION', [files.api[0]]],
    ['api', 'DEPLOYLITE_P3_DOCKER_INTEGRATION', [files.api[1]]],
    ['agent', 'DEPLOYLITE_P4_PHYSICAL', files.agent]
  ]) {
    const excluded = excludedPhysicalTestFiles(workspace, { [flag]: '1' });
    for (const path of selected) assert(!excluded.includes(path));
  }
});
test('a flag from another job cannot activate unrelated runtime tests', () => {
  assert(excludedPhysicalTestFiles('api', { DEPLOYLITE_DB_INTEGRATION: '1' }).includes(files.api[0]));
  assert(excludedPhysicalTestFiles('agent', { DEPLOYLITE_DOCKER_INTEGRATION: '1' }).includes(files.agent[0]));
  assert(excludedPhysicalTestFiles('db', { DEPLOYLITE_API_POSTGRES_INTEGRATION: '1' }).includes(files.db[0]));
});
test('configurations explicitly use the execution partition and preserve default exclusions', () => {
  for (const path of ['packages/db/vitest.config.ts', 'apps/api/vitest.config.ts', 'apps/agent/vitest.config.ts']) {
    const source = readFileSync(new URL('../../'+path, import.meta.url), 'utf8');
    assert(source.includes('excludedPhysicalTestFiles'));
    assert(source.includes('configDefaults.exclude'));
  }
});
test('mapped suites never manufacture skipped cases; original hosted count guards remain', () => {
  for (const path of ['packages/db/src/postgres.integration.test.ts', 'packages/db/src/compose-postgres.integration.test.ts', 'apps/api/src/postgres.integration.test.ts', 'apps/api/src/compose-resource-docker.integration.test.ts', 'apps/api/src/deployment-docker.integration.test.ts', 'apps/agent/src/infrastructure/docker/docker-redaction-integration.test.ts', 'apps/agent/src/infrastructure/docker/docker-transport-port-executor.physical.test.ts']) {
    const source = readFileSync(new URL('../../'+path, import.meta.url), 'utf8');
    assert(!/\b(?:describe|it|test)\.skip(?:If)?\b/.test(source), path);
  }
  const workflow=readFileSync(new URL('../../.github/workflows/baseline.yml',import.meta.url),'utf8');
  for(const name of ['postgres-integration','p2-docker-acceptance','p3-docker-acceptance','p4-transport-acceptance']) assert(workflow.split('  baseline-gate:\n')[1].includes(name));
  assert(workflow.includes('numPendingTests !== 0'));
});

test('every declared acceptance source exists on this exact branch', () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('scripts/ci/p2-acceptance-cases.json', root), 'utf8'));
  for (const path of manifest.sourceFiles) assert.ok(existsSync(new URL(path, root)), `Missing acceptance source: ${path}`);
});
