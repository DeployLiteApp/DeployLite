declare module "@deploylite/db" {
  export function createDbPool(connectionString: string): { end(): Promise<void> };
  export function createDbClient(pool: unknown): unknown;
  export function closeDbPool(pool: { end(): Promise<void> }): Promise<void>;
  export class DbControlCommandRepository {
    constructor(db: unknown);
    validateInitialExecution(projectId: string, executionId: string, binding: import("@deploylite/domain").InitialExecutionBinding): Promise<void>;
    validateDeploymentAuthority(authority: import("@deploylite/contracts").DeploymentExecutionAuthorityV1, now?: number): Promise<void>;
  }
  export class DbEnvSecretValueRepository {
    constructor(db: unknown);
    listByProject: import("@deploylite/domain").EnvSecretValueRepository["listByProject"];
    listEncryptedByProject: import("@deploylite/domain").EnvSecretValueRepository["listEncryptedByProject"];
    upsert: import("@deploylite/domain").EnvSecretValueRepository["upsert"];
    remove: import("@deploylite/domain").EnvSecretValueRepository["remove"];
  }
  export class DbAgentReplayStore {
    readonly durable: true;
    constructor(db: unknown, owner: string);
    lookup(commandId: string, fingerprint: string): Promise<Record<string, unknown> | null>;
    claim(commandId: string, fingerprint: string, lease: unknown): Promise<{ claimed: boolean; receipt?: any }>;
    wait(commandId: string): Promise<any>;
    complete(commandId: string, value: unknown): Promise<void>;
    release(commandId: string): Promise<void>;
  }
}
