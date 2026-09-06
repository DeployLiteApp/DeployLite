// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConfigureDeploymentPage from "./page";
import { loadRequestAuthSession } from "@/lib/server-auth";

vi.mock("@/lib/server-auth", () => ({ loadRequestAuthSession: vi.fn(), loadRequestDashboardMetadata: vi.fn() }));

describe("ConfigureDeploymentPage", () => {
  it("keeps the configure route behind authentication", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "unauthenticated", reason: "missing-cookie" });
    render(await ConfigureDeploymentPage({ searchParams: Promise.resolve({ source: "github" }) }));
    expect(screen.getByRole("link", { name: "Sign in required" })).toBeTruthy();
  });
});
