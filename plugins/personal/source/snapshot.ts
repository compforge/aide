/** Facts committed by a Source; refresh/admission progress lives separately in its checkpoint. */
export interface SourceSnapshot<T> {
  readonly value: T;
  readonly observedAt: string;
}
