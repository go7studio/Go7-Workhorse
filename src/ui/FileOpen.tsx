import { createContext, useContext, type ReactNode } from "react";
import { fileFolderFromPath, fileNameFromPath, looksLikeSourceFile, type ProjectEdit } from "../lib/project-edits";
import type { ProviderId } from "../lib/types";

export type FileOpenApi = {
  roots: string[];
  provider: ProviderId;
  open: (file: ProjectEdit) => void;
};

const FileOpenContext = createContext<FileOpenApi | null>(null);

export function FileOpenProvider({
  roots,
  provider,
  onOpen,
  children,
}: {
  roots: string[];
  provider: ProviderId;
  onOpen: (file: ProjectEdit) => void;
  children: ReactNode;
}) {
  const open = (file: ProjectEdit) => {
    const request = window.workhorse?.resolveFile?.(file.path, roots);
    if (!request) {
      onOpen(file);
      return;
    }
    void request.then((resolved) => {
      const path = resolved || file.path;
      onOpen({
        ...file,
        path,
        name: fileNameFromPath(path),
        folder: fileFolderFromPath(path, roots),
      });
    });
  };
  return <FileOpenContext.Provider value={{ roots, provider, open }}>{children}</FileOpenContext.Provider>;
}

export function useFileOpen(): FileOpenApi | null {
  return useContext(FileOpenContext);
}

export function editFromMention(path: string, provider: ProviderId, roots: string[] = []): ProjectEdit {
  return {
    path,
    name: fileNameFromPath(path),
    folder: fileFolderFromPath(path, roots),
    edits: 0,
    at: Date.now(),
    provider,
  };
}

export function isOpenableSource(value: string): boolean {
  return looksLikeSourceFile(value);
}
