const label = (name: string) => `{{json (index .Labels "com.deploylite.${name}")}}`;
const common = `"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"optionsCount":{{len .Options}},"owner":${label("owner")},"projectId":${label("project")},"resourceKind":${label("resource.kind")},"resourceKey":${label("resource.key")},"databaseId":${label("database")},"commandId":${label("database.command")},"planDigest":${label("database.plan")}`;
export const MANAGED_DATABASE_NETWORK_INSPECT_FORMAT = `{"id":{{json .Id}},"internal":{{json .Internal}},${common}}`;
export const MANAGED_DATABASE_VOLUME_INSPECT_FORMAT = `{"createdAt":{{json .CreatedAt}},${common}}`;
