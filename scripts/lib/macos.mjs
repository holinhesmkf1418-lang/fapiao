import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function chooseWorkRoot(defaultPath) {
  const script = `POSIX path of (choose folder with prompt "请选择发票工作目录" default location POSIX file "${escapeAppleScript(defaultPath)}")`;
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.trim().replace(/\/$/, "");
}

export async function openBrowser(url) {
  await execFileAsync("open", [url]);
}
