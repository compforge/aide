import type { Resource } from "@compforge/aide-plugin";
export const ROUTE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Route" } as const;
export const ROUTE_NAME = "global";
export const ROUTE_TARGET = "personal-route";
export interface Destination { name: string; uid: string }
export interface RouteDecision { inputId: string; destinations: Destination[]; reason: string }
export interface RouteCandidate extends Destination { id: string; nameHint: string; summary: string; default: boolean }
export interface RouteBatch {
  id: string;
  inputIds: string[];
  createdAt: string;
  phase: "queued" | "running" | "planned";
  prompt: string;
  candidates: RouteCandidate[];
  plan?: RouteDecision[];
}
export interface RouteStatus { pendingInputIds: string[]; batch?: RouteBatch | null }
export type RouteResource = Resource<Record<string, never>, RouteStatus>;
