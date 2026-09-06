// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
afterEach(() => cleanup());

describe("AppShell", () => {
  it("keeps a compact mobile bar while preserving navigation and sign out", () => {
    render(<AppShell email="admin@example.test"><p>Content</p></AppShell>);

    expect(screen.getByRole("navigation", { name: "Primary" }).className).toContain("flex-col");
    expect(screen.getByRole("navigation", { name: "Mobile bottom navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText("admin@example.test").className).toContain("truncate");
  });
});
