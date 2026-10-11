import {managedDatabaseLogsAgentQuerySchema, managedDatabaseLogsObservationSchema, type ManagedDatabaseLogsAgentQueryV1} from "@deploylite/contracts";
import {redactLogMessage} from "@deploylite/config";
import {managedDatabaseHealthSourceBinding, managedDatabaseHealthObservationMatches} from "./managed-database-health-binding.js";
function healthQuery(query: ManagedDatabaseLogsAgentQueryV1) {
  const {selection: _selection, ...source} = query;
  return {...source, action: "database.runtime.health", requiredCapabilities: ["database.runtime.health.v1"]};
}
/** A log read retains original execution digest and immutable scope with no ledger command. */
export function managedDatabaseLogsSourceBinding(raw: unknown) {
  try {
    const query = managedDatabaseLogsAgentQuerySchema.parse(raw);
    managedDatabaseHealthSourceBinding(healthQuery(query));
    return query;
  } catch {throw new Error("Database logs source is unavailable.");}
}
/** Full identity, sanitized text and batch time must all belong to this bounded query. */
export function managedDatabaseLogsObservationMatches(rawQuery: unknown, rawObservation: unknown, before: number, after: number): boolean {
  try {
    const query = managedDatabaseLogsSourceBinding(rawQuery), observation = managedDatabaseLogsObservationSchema.parse(rawObservation);
    const {logs, logsObservedAt, ...health} = observation;
    return managedDatabaseHealthObservationMatches(healthQuery(query), {...health, action: "database.runtime.health"}, before, after)
      && logsObservedAt >= before && logsObservedAt <= after
      && (query.selection.since === undefined || Date.parse(query.selection.since) <= before)
      && redactLogMessage(logs.stdout) === logs.stdout && redactLogMessage(logs.stderr) === logs.stderr;
  } catch {return false;}
}
