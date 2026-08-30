import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuditEventListItem } from "@deploylite/contracts";
import { ProjectAuditHistoryPanel } from "./project-audit-history-panel.js";

const props = {
  apiBaseUrl: "https://api.example.test",
  cookieHeader: "session=operator",
  projectId: "project_alpha"
};

describe("ProjectAuditHistoryPanel edge states", () => {
  it("keeps an empty loaded window distinct from a restricted response", () => {
    const empty = renderToStaticMarkup(<ProjectAuditHistoryPanel {...props} initialEvents={[]} initialTotal={0} initialState={{ kind: "ready" }} />);
    const forbidden = renderToStaticMarkup(<ProjectAuditHistoryPanel {...props} initialEvents={[]} initialTotal={0} initialState={{ kind: "error", reason: "forbidden", status: 403 }} />);

    expect(empty).toContain("No audit events yet");
    expect(empty).toContain("Open full audit history");
    expect(forbidden).toContain("restricted to operator or admin");
    expect(forbidden).not.toContain("Open full audit history");
  });

  it("limits the in-page preview without changing the full-history total", () => {
    const events: AuditEventListItem[] = Array.from({ length: 6 }, (_, index) => ({
      id: `audit_${index}`,
      actorId: "user_admin_1",
      action: "project.update",
      targetType: "project",
      targetId: "project_alpha",
      requestId: `req_${index}`,
      correlationId: `corr_${index}`,
      timestamp: "2026-07-01T12:00:00.000Z"
    }));
    const html = renderToStaticMarkup(<ProjectAuditHistoryPanel {...props} initialEvents={events} initialTotal={125} initialState={{ kind: "ready" }} />);

    expect((html.match(/project.update/g) ?? []).length).toBe(5);
    expect(html).toContain("125 event(s) in the most recent window.");
  });
});
