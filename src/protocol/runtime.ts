/** Private execution backend coordinate used by Host/Runner IPC. Never a resource owner. */
export interface RuntimeScope {
  readonly aideSessionId: string;
  readonly cwd?: string;
}
