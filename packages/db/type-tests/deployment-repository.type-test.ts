import type { DeploymentRepository } from "@deploylite/domain";

import type { DbDeploymentRepository } from "../src/repositories/deployment-data.js";

declare const databaseRepository: DbDeploymentRepository;

const publicRepository: DeploymentRepository = databaseRepository;

void publicRepository;
