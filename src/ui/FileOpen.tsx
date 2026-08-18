import { createContext, useContext, type ReactNode } from "react";
import { editSearchRoots, fileFolderFromPath, fileNameFromPath, harvestFilePath, looksLikeSourceFile, type ProjectEdit } from "../lib/project-edits";
import type { ProviderId } from "../lib/types";

export type FileOpenApi = {
  roots: string[];
  provider: ProviderId;
  nearby: string;
  open: (file: ProjectEdit) => void;
};

const FileOpenContext = createContext<FileOpenApi | null>(null);

export function FileOpenProvider({
  roots,
  provider,
  nearby = "",
  onOpen,
  children,
}: {
  roots: string[];
  provider: ProviderId;
  nearby?: string;
  onOpen: (file: ProjectEdit) => void;
  children: ReactNode;
}) {
  const open = (file: ProjectEdit) => {
    const cited = harvestFilePath(file.path, nearby, undefined, roots);
    const request = window.workhorse?.resolveFile?.(cited, editSearchRoots(roots, file.folder));
    if (!request) {
      onOpen({ ...file, path: cited, name: fileNameFromPath(cited), folder: fileFolderFromPath(cited, roots) });
      return;
    }
    void request.then((resolved) => {
      const path = resolved || cited;
      onOpen({
        ...file,
        path,
        name: fileNameFromPath(path),
        folder: fileFolderFromPath(path, roots),
      });
    });
  };
  return <FileOpenContext.Provider value={{ roots, provider, nearby, open }}>{children}</FileOpenContext.Provider>;
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
