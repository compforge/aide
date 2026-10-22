/** Environment shared by Host and Runner; no execution journal identity. */
export interface RuntimeScope {
  readonly cwd?: string;
}
