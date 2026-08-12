/// <reference types="vite/client" />

type WorkhorseBridge = {
  pickFolder: () => Promise<string | null>;
  pickFile: () => Promise<string | null>;
  revealProject: (folder: string) => Promise<void>;
  loadState: () => Promise<Record<string, unknown>>;
  saveState: (state: Record<string, unknown>) => Promise<void>;
  quit: () => Promise<void>;
};

interface Window {
  workhorse?: WorkhorseBridge;
}
