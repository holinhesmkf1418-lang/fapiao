import { AppShell } from "@/components/app-shell";

export default function ExportsPage() {
  return (
    <AppShell activePath="/exports">
      <section className="workbench-content">
        <h2>整理导出</h2>
        <p>导出本机整理完成的发票数据。</p>
      </section>
    </AppShell>
  );
}
