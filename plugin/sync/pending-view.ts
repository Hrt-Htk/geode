export type PendingStage = "queued" | "pushing";

export interface PendingView {
  path: string;
  kind: string;
  stage: PendingStage;
}

export function mergePendingViews(
  queued: Array<{ path: string; kind: string }>,
  inFlight: Array<{ path: string; kind: string }>,
): PendingView[] {
  const inFlightPaths = new Set(inFlight.map((op) => op.path));
  const result: PendingView[] = [];

  for (const op of inFlight) {
    result.push({ path: op.path, kind: op.kind, stage: "pushing" });
  }

  for (const op of queued) {
    if (!inFlightPaths.has(op.path)) {
      result.push({ path: op.path, kind: op.kind, stage: "queued" });
    }
  }

  return result;
}
