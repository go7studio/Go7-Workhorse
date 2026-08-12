/// <reference types="vite/client" />

type WorkhorseBridge = {
  pickProject: () => Promise<string | null>;
  revealProject: (folder: string) => Promise<void>;
  loadState: () => Promise<Record<string, unknown>>;
  saveState: (state: Record<string, unknown>) => Promise<void>;
  quit: () => Promise<void>;
};

interface Window {
  workhorse?: WorkhorseBridge;
}
