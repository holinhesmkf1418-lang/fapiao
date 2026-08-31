import { AppShell } from "@/components/app-shell";

export default function InvoicesPage() {
  return (
    <AppShell activePath="/invoices">
      <section className="workbench-content">
        <h2>发票管理</h2>
        <p>管理已整理的本地发票。</p>
      </section>
    </AppShell>
  );
}
