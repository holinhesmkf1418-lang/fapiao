import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";

afterEach(cleanup);

it("renders the four local workbench destinations", () => {
  render(
    <AppShell activePath="/">
      <div>内容</div>
    </AppShell>,
  );

  for (const name of ["总览", "上传发票", "发票管理", "整理导出"]) {
    expect(screen.getAllByRole("link", { name })[0]).toBeInTheDocument();
  }

  expect(screen.getByText("仅保存在这台 Mac")).toBeInTheDocument();
});

it("renders the accessible workbench title in main content", () => {
  render(
    <AppShell activePath="/">
      <div>内容</div>
    </AppShell>,
  );

  expect(within(screen.getByRole("main")).getByRole("heading", { name: "发票工作台" })).toBeInTheDocument();
});
