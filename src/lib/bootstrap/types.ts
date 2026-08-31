export type BootstrapConfig = {
  version: 1;
  workRoot: string;
  lastPort: number;
};

export type RuntimeInfo = {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
};

export type WorkPaths = {
  root: string;
  data: string;
  invoices: string;
  exports: string;
  backups: string;
  logs: string;
};
