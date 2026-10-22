export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}): ${path}`);
  return data as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
