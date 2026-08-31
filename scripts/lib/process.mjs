import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function canListen(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePort(host, first, last) {
  for (let port = first; port <= last; port += 1) {
    if (await canListen(host, port)) return port;
  }

  throw new Error("NO_AVAILABLE_LOCAL_PORT");
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isOwnedServerCommand(command, expectedServerFile) {
  return (
    typeof command === "string" &&
    command.includes(expectedServerFile) &&
    command.includes("node")
  );
}

export function isOwnedServerIdentity(command, workingDirectory, expectedServerFile) {
  if (isOwnedServerCommand(command, expectedServerFile)) return true;
  return (
    command.startsWith("next-server ") &&
    resolve(workingDirectory) === resolve(dirname(expectedServerFile))
  );
}

export async function getProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getProcessWorkingDirectory(pid) {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    const pathLine = stdout.split("\n").find((line) => line.startsWith("n"));
    return pathLine?.slice(1) ?? "";
  } catch {
    return "";
  }
}

export async function healthIsOk(port, timeoutMs = 1_500) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}

export async function isRecordedProcessAlive(runtime, expectedServerFile) {
  if (!runtime || !isPidAlive(runtime.pid)) return false;
  const [command, workingDirectory] = await Promise.all([
    getProcessCommand(runtime.pid),
    getProcessWorkingDirectory(runtime.pid),
  ]);
  if (!isOwnedServerIdentity(command, workingDirectory, expectedServerFile)) {
    return false;
  }
  return healthIsOk(runtime.port);
}

export async function waitForHealth(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthIsOk(port, 500)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("LOCAL_SERVER_START_TIMEOUT");
}
