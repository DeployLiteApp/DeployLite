// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentSourceSelector } from "./deployment-source-selector";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => { cleanup(); push.mockReset(); });

describe("DeploymentSourceSelector", () => {
  it("renders the measured source choices as an accessible radio group", () => {
    render(<DeploymentSourceSelector />);
    expect(screen.getByRole("heading", { name: "Selecciona qué quieres desplegar" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect((screen.getByRole("radio", { name: /Repositorio Git/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Lo que ocurrirá después")).toBeTruthy();
    expect(screen.getByText("Conecta tu fuente y prepara el build.")).toBeTruthy();
    expect(screen.getByText("Podrás editar los datos antes de continuar.")).toBeTruthy();
  });

  it("preserves the selected source when moving to configuration", () => {
    render(<DeploymentSourceSelector />);
    const github = screen.getByRole("radio", { name: /Repositorio Git/ });
    const docker = screen.getByRole("radio", { name: /Imagen Docker/ });
    github.focus();
    fireEvent.keyDown(github, { key: "ArrowRight" });
    expect(docker.parentElement?.className).toContain("deployment-wizard__source--selected");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(push).toHaveBeenCalledWith("/deployments/new/configure?source=docker");
  });

  it("cancels without touching deployment history", () => {
    render(<DeploymentSourceSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(push).toHaveBeenCalledWith("/deployments");
  });
});
