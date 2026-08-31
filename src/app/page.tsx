import { AppShell } from "@/components/app-shell";

export default function OverviewPage() {
  return (
    <AppShell activePath="/">
      <section className="workbench-content">
        <h2>总览</h2>
        <p>在这里查看本机发票整理进度。</p>
      </section>
    </AppShell>
  );
}
