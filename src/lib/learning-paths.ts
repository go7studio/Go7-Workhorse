import path from "node:path";
import { LEARNING_DB_FILE, LEARNING_DIR_NAME, LEARNING_INBOUND_FILE } from "./learning-types";

export function learningDatabasePath(userData: string): string {
  return path.join(userData, LEARNING_DIR_NAME, LEARNING_DB_FILE);
}

export function learningInboundPath(userData: string): string {
  return path.join(userData, LEARNING_DIR_NAME, LEARNING_INBOUND_FILE);
}

export function learningSidecarPaths(dbPath: string): { wal: string; shm: string } {
  return { wal: `${dbPath}-wal`, shm: `${dbPath}-shm` };
}

export function usesHomePath(value: string): boolean {
  return /(^|[/\\])Users[/\\]|[/\\]home[/\\]|^[A-Za-z]:\\Users\\/i.test(value);
}
