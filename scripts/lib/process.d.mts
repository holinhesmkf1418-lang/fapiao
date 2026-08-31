export type RecordedProcess = {
  pid: number;
  port: number;
};

export function findAvailablePort(
  host: string,
  first: number,
  last: number,
): Promise<number>;
export function isPidAlive(pid: number): boolean;
export function isOwnedServerCommand(
  command: string,
  expectedServerFile: string,
): boolean;
export function isOwnedServerIdentity(
  command: string,
  workingDirectory: string,
  expectedServerFile: string,
): boolean;
export function getProcessCommand(pid: number): Promise<string>;
export function getProcessWorkingDirectory(pid: number): Promise<string>;
export function healthIsOk(port: number, timeoutMs?: number): Promise<boolean>;
export function isRecordedProcessAlive(
  runtime: RecordedProcess | null,
  expectedServerFile: string,
): Promise<boolean>;
export function waitForHealth(port: number, timeoutMs?: number): Promise<void>;
