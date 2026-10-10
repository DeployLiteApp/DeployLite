const label = (name: string) => `{{json (index .Config.Labels "com.deploylite.${name}")}}`;
export const MANAGED_DATABASE_IMAGE_INSPECT_FORMAT = '{"id":{{json .Id}},"volumes":{{json .Config.Volumes}}}';
export const MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT = [
    '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"image":{{json .Config.Image}},',
    `"owner":${label("owner")},"projectId":${label("project")},"databaseId":${label("database")},"engine":${label("database.engine")},`,
    `"commandId":${label("database.command")},"planDigest":${label("database.plan")},"environmentFingerprint":${label("database.environment")},`,
    `"networkMode":{{json .HostConfig.NetworkMode}},"storageInitialization":${label("database.storage-init")},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"user":{{json .Config.User}},`,
    '"readOnly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},',
    '"cpu":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}},"ports":{{json .HostConfig.PortBindings}}}'
].join("");
