import {managedDatabaseMetricsAgentQuerySchema,managedDatabaseMetricsObservationSchema} from "@deploylite/contracts";
import {managedDatabaseHealthSourceBinding,managedDatabaseHealthObservationMatches} from "./managed-database-health-binding.js";
function healthQuery(query:ReturnType<typeof managedDatabaseMetricsAgentQuerySchema.parse>){return {...query,action:"database.runtime.health",requiredCapabilities:["database.runtime.health.v1"]};}
/** Reuse original execution digest and strict scope binding for this readonly operation. */
export function managedDatabaseMetricsSourceBinding(raw:unknown){
 try{const query=managedDatabaseMetricsAgentQuerySchema.parse(raw);managedDatabaseHealthSourceBinding(healthQuery(query));return query;}
 catch{throw new Error("Database metrics source is unavailable.");}
}
/** Counters and physical observation must both belong to this current bounded request. */
export function managedDatabaseMetricsObservationMatches(rawQuery:unknown,rawObservation:unknown,before:number,after:number):boolean{
 try{
  const query=managedDatabaseMetricsSourceBinding(rawQuery),observation=managedDatabaseMetricsObservationSchema.parse(rawObservation);
  const {metrics:_metrics,metricsObservedAt,...health}=observation;
  return managedDatabaseHealthObservationMatches(healthQuery(query),{...health,action:"database.runtime.health"},before,after)
   &&(metricsObservedAt===null?observation.state==="stopped":metricsObservedAt>=before&&metricsObservedAt<=after);
 }catch{return false;}
}
