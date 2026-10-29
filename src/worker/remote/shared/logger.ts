export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event, error: error instanceof Error ? error.message : 'unknown', ...fields }));
}
