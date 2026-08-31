import type { JSX, ReactNode } from "react";

const destinations = [
  { href: "/", label: "总览" },
  { href: "/upload", label: "上传发票" },
  { href: "/invoices", label: "发票管理" },
  { href: "/exports", label: "整理导出" },
];

type AppShellProps = {
  children: ReactNode;
  activePath: string;
};

export function AppShell({ children, activePath }: AppShellProps): JSX.Element {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">发票工作台</div>
        <nav>
          {destinations.map(({ href, label }) => (
            <a aria-current={activePath === href ? "page" : undefined} href={href} key={href}>
              {label}
            </a>
          ))}
        </nav>
        <p>仅保存在这台 Mac</p>
      </aside>
      <main>
        <header className="workbench-header">
          <h1>发票工作台</h1>
        </header>
        {children}
      </main>
      <nav aria-label="底部导航" className="bottom-navigation">
        {destinations.map(({ href, label }) => (
          <a aria-current={activePath === href ? "page" : undefined} href={href} key={href}>
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
