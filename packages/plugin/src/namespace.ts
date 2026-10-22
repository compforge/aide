/** Plugin-owned namespace path. Segments carry no built-in business or execution meaning. */
export type ResourceNamespace = "v1" | `v1/${string}`;
export type AnyResourceNamespace = ResourceNamespace;
