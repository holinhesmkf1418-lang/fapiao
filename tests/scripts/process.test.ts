import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAvailablePort,
  isOwnedServerCommand,
  isOwnedServerIdentity,
  isRecordedProcessAlive,
} from "../../scripts/lib/process.mjs";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("launcher process helpers", () => {
  it("skips an occupied loopback port", async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    await expect(
      findAvailablePort("127.0.0.1", address.port, address.port + 1),
    ).resolves.toBe(address.port + 1);
  });

  it("only accepts a command that owns the expected standalone server", () => {
    const serverFile = "/Applications/发票工作台/.next/standalone/server.js";

    expect(isOwnedServerCommand(`node ${serverFile}`, serverFile)).toBe(true);
    expect(isOwnedServerCommand("node unrelated-server.js", serverFile)).toBe(false);
  });

  it("recognizes the runtime title Next.js assigns inside the standalone directory", () => {
    const serverFile = "/Applications/发票工作台/.next/standalone/server.js";
    const standaloneDirectory = "/Applications/发票工作台/.next/standalone";

    expect(
      isOwnedServerIdentity(
        "next-server (v16.3.3)",
        standaloneDirectory,
        serverFile,
      ),
    ).toBe(true);
    expect(
      isOwnedServerIdentity("next-server (v16.3.3)", "/tmp", serverFile),
    ).toBe(false);
  });

  it("treats an invalid recorded pid as stopped", async () => {
    await expect(
      isRecordedProcessAlive(
        { pid: -1, port: 4876 },
        "/Applications/发票工作台/.next/standalone/server.js",
      ),
    ).resolves.toBe(false);
  });
});
