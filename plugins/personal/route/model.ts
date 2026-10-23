import type { Resource } from "@compforge/aide-plugin";
import type { LoopStatus } from "../loop.ts";
export const ROUTE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Route" } as const;
export const ROUTE_NAME = "global";
export const ROUTE_HARNESS = "route";
export interface Destination { name: string; uid: string }
export type RouteStatus = LoopStatus;
export type RouteResource = Resource<Record<string, never>, RouteStatus>;
