import { AppShell } from "@/components/app-shell";

export default function UploadPage() {
  return (
    <AppShell activePath="/upload">
      <section className="workbench-content">
        <h2>上传发票</h2>
        <p>选择需要整理的本地发票文件。</p>
      </section>
    </AppShell>
  );
}
