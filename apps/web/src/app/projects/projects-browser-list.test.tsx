import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectsBrowserList } from "./projects-browser-list.js";
import type { ProjectLaunchSummary } from "./project-launch-hub.js";

const row = (id: string, name: string): ProjectLaunchSummary => ({
  project: { id, name, repoUrl: `https://github.com/example/${id}`, defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null },
  runtime: { configured: false, label: "Needs command", detail: "Set a run command and port before triggering useful deploys." },
  latest: { deployment: null, statusLabel: "Not run", statusTone: "muted" },
  nextAction: { label: "Configure runtime", ctaKey: "configure-runtime", href: `/projects/${id}#env-metadata` },
  hasLatestDeployment: false, logsHref: null, configureHref: `/projects/${id}#env-metadata`, deployHref: `/projects/${id}#deploy-actions`
});

describe("ProjectsBrowserList", () => {
  it("renders API-provided names as detail links with honest accessible context", () => {
    const html = renderToStaticMarkup(<ProjectsBrowserList rows={[row("alpha", "Alpha service"), row("beta", "Beta worker")]} />);
    expect(html).toContain("Alpha service");
    expect(html).toContain('href="/projects/alpha"');
    expect(html).toContain("Latest deployment: Not run");
    expect(html).toContain("Beta worker");
    expect(html).not.toContain("Production");
  });
});
