import { crewActivityLine, crewTurnInFlight } from "./crew-live";
import type { Session } from "./types";

export function crewWorkers(sessions: Session[], parentId: string): Session[] {
  return sessions.filter((session) => session.parentId === parentId && !session.archivedAt);
}

export function crewIsLive(session: Session): boolean {
  return crewTurnInFlight(session);
}

export function crewActivity(session: Session): string {
  return crewActivityLine(session);
}
