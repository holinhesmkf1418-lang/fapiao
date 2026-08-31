export type StartDecision =
  | { action: "open-existing" }
  | { action: "start-new" };

export function decideStart(input: {
  healthOk: boolean;
  pidAlive: boolean;
}): StartDecision;

export function startLocal(options?: {
  dryRun?: boolean;
  open?: boolean;
}): Promise<
  | { action: "dry-run"; port: number; workRoot: string }
  | { action: "open-existing"; pid: number; port: number }
  | { action: "start-new"; pid: number; port: number }
>;
