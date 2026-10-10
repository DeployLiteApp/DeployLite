/** Collection boundaries only. Every physical partition remains a required hosted baseline job. */
const physical = Object.freeze({
  db: Object.freeze([
    ['src/postgres.integration.test.ts', 'DEPLOYLITE_DB_INTEGRATION'],
    ['src/compose-postgres.integration.test.ts', 'DEPLOYLITE_DB_INTEGRATION']
  ]),
  api: Object.freeze([
    ['src/postgres.integration.test.ts', 'DEPLOYLITE_API_POSTGRES_INTEGRATION'],
    ['src/compose-resource-docker.integration.test.ts', 'DEPLOYLITE_P3_DOCKER_INTEGRATION']
  ]),
  agent: Object.freeze([
    ['src/infrastructure/docker/docker-transport-port-executor.physical.test.ts', 'DEPLOYLITE_P4_PHYSICAL']
  ])
});
export function excludedPhysicalTestFiles(workspace, environment = process.env) {
  if (!Object.hasOwn(physical, workspace)) throw new Error('Unknown test execution partition');
  return Object.freeze(physical[workspace].filter(([, flag]) => environment[flag] !== '1').map(([path]) => path));
}
