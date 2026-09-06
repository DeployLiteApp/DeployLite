// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigureDeploymentForm, validateConfigureDraft } from "./configure-form";

const online = { id: "agent-1", name: "Build server", endpoint: "https://server.example", status: "online", lastHeartbeatAt: null, resourceSnapshot: null } as const;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

describe("configure deployment", () => {
  it("requires a permitted online server and valid repository and branch", () => {
    expect(validateConfigureDraft({ repoUrl: "bad", branch: "main", agentId: "agent-1" }, [online])).toBe("Repositorio no válido.");
    expect(validateConfigureDraft({ repoUrl: "https://github.com/org/repo", branch: "", agentId: "agent-1" }, [online])).toBe("La rama o tag es obligatorio.");
    expect(validateConfigureDraft({ repoUrl: "https://github.com/org/repo", branch: "main", agentId: "agent-1" }, [online])).toBeNull();
  });
  it("does not show validated state before submission", () => {
    render(<ConfigureDeploymentForm agents={[online]} metadataReady />);
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    expect(screen.getByRole("alert").textContent).toContain("Repositorio no válido.");
  });
  it("keeps validated values in memory for review without a network mutation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ConfigureDeploymentForm agents={[online]} metadataReady />);
    fireEvent.change(screen.getByLabelText("Repositorio"), { target: { value: "https://github.com/org/repo" } });
    fireEvent.change(screen.getByLabelText("Rama / tag"), { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Servidor"), { target: { value: "agent-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    expect(screen.getByRole("heading", { name: "Revisa antes de desplegar" })).toBeTruthy();
    expect(screen.getByText("https://github.com/org/repo")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.getAllByText("Build server")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Desplegar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("El despliegue desde Git aún no está disponible. No se ha iniciado ningún despliegue.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    expect((screen.getByLabelText("Rama / tag") as HTMLInputElement).value).toBe("release");
    fetchSpy.mockRestore();
  });
});
