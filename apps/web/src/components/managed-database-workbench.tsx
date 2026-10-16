"use client";
import {useCallback, useState} from "react";
import {ManagedDatabaseOperatorCard} from "./managed-database-operator-card";
import {ManagedDatabaseInventoryPanel} from "./managed-database-inventory-panel";
/** Confirmed creation refreshes stored metadata; selection never executes a runtime command. */
export function ManagedDatabaseWorkbench({projectId, apiBaseUrl, actorId}: {projectId: string; apiBaseUrl: string | null; actorId?: string}) {
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const created = useCallback((databaseId: string) => {
    setSelectedDatabaseId(databaseId); setRefreshKey(value => value + 1);
  }, []);
  return <div className="space-y-4">
    <ManagedDatabaseOperatorCard projectId={projectId} apiBaseUrl={apiBaseUrl} onCreated={created} />
    {apiBaseUrl ? <ManagedDatabaseInventoryPanel projectId={projectId} apiBaseUrl={apiBaseUrl} refreshKey={refreshKey}
      selectedDatabaseId={selectedDatabaseId} onSelect={setSelectedDatabaseId} {...(actorId ? {actorId} : {})} /> : null}
  </div>;
}
