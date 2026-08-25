import { useMemo, useState } from "react";
import { useStore } from "../lib/store";
import type { McpRuntimeId, McpServerConfig, ProviderId } from "../lib/types";

type Editor = {
  originalName?: string;
  server: McpServerConfig;
  argsText: string;
  envText: string;
  removedEnv: string[];
  everyRuntime: boolean;
  everyTool: boolean;
  discoveredTools: string[];
};

const STOCK_RUNTIMES: Array<{ id: ProviderId; label: string }> = [
  { id: "grok", label: "Grok" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "custom", label: "Custom HTTP" },
];

function isCustomRuntime(id: McpRuntimeId): boolean {
  return id === "custom" || id.startsWith("custom:");
}

function editorFor(server?: McpServerConfig): Editor {
  if (!server) {
    return {
      server: { name: "", command: "", args: [], runtimeIds: [], includeTools: [] },
      argsText: "",
      envText: "",
      removedEnv: [],
      everyRuntime: false,
      everyTool: true,
      discoveredTools: [],
    };
  }
  const restricted = server.includeTools !== undefined;
  const customRuntimes = (server.runtimeIds ?? []).filter(isCustomRuntime);
  const runtimeIds = restricted
    ? (customRuntimes.length > 0 ? customRuntimes : ["custom" as McpRuntimeId])
    : server.runtimeIds;
  return {
    originalName: server.name,
    server: { ...server, args: [...server.args], env: server.env ? { ...server.env } : undefined, runtimeIds },
    argsText: server.args.join("\n"),
    envText: "",
    removedEnv: [],
    everyRuntime: !restricted && server.runtimeIds === undefined,
    everyTool: server.includeTools === undefined,
    discoveredTools: server.includeTools ? [...server.includeTools] : [],
  };
}

function parsedEnv(text: string): { env: Record<string, string>; invalid?: string } {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const split = line.indexOf("=");
    const name = split >= 0 ? line.slice(0, split).trim() : "";
    const value = split >= 0 ? line.slice(split + 1) : "";
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value) return { env, invalid: line };
    env[name] = value;
  }
  return { env };
}

function replaceServer(servers: McpServerConfig[], editor: Editor): McpServerConfig[] {
  const additions = parsedEnv(editor.envText).env;
  const env = Object.fromEntries(Object.entries({ ...(editor.server.env ?? {}), ...additions }).filter(([name]) => !editor.removedEnv.includes(name)));
  const envCredentialIds = Object.fromEntries(Object.entries(editor.server.envCredentialIds ?? {}).filter(([name]) => !editor.removedEnv.includes(name)));
  const saved: McpServerConfig = {
    ...editor.server,
    name: editor.server.name.trim(),
    command: editor.server.command.trim(),
    args: editor.argsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    ...(Object.keys(env).length > 0 ? { env } : { env: undefined }),
    ...(Object.keys(envCredentialIds).length > 0 ? { envCredentialIds } : { envCredentialIds: undefined }),
    ...(editor.everyRuntime ? { runtimeIds: undefined } : { runtimeIds: editor.server.runtimeIds ?? [] }),
    ...(editor.everyTool ? { includeTools: undefined } : { includeTools: editor.server.includeTools ?? [] }),
  };
  if (!editor.originalName) return [...servers, saved];
  return servers.map((server) => server.name === editor.originalName ? saved : server);
}

export function McpServersPane() {
  const store = useStore();
  const servers = store.settings.mcpServers;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [note, setNote] = useState("");
  const [probing, setProbing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const runtimes = useMemo(() => [
    ...STOCK_RUNTIMES,
    ...store.settings.customBots.map((bot) => ({ id: `custom:${bot.id}` as McpRuntimeId, label: bot.name.trim() || "Untitled bot" })),
  ], [store.settings.customBots]);

  const patchServer = (patch: Partial<McpServerConfig>) => {
    setEditor((current) => current ? { ...current, server: { ...current.server, ...patch } } : current);
    setNote("");
  };

  const toggleRuntime = (id: McpRuntimeId) => {
    if (!editor) return;
    const current = editor.server.runtimeIds ?? [];
    patchServer({ runtimeIds: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  };

  const toggleTool = (name: string) => {
    if (!editor) return;
    const current = editor.server.includeTools ?? [];
    patchServer({ includeTools: current.includes(name) ? current.filter((item) => item !== name) : [...current, name] });
  };

  const setEveryTool = (everyTool: boolean) => {
    setEditor((current) => {
      if (!current) return current;
      if (everyTool) return { ...current, everyTool: true };
      const customRuntimes = (current.server.runtimeIds ?? []).filter(isCustomRuntime);
      return {
        ...current,
        everyTool: false,
        everyRuntime: false,
        server: {
          ...current.server,
          runtimeIds: customRuntimes.length > 0 ? customRuntimes : ["custom"],
          includeTools: current.server.includeTools ?? [],
        },
      };
    });
    setNote("");
  };

  const save = async () => {
    if (!editor) return;
    const name = editor.server.name.trim();
    if (!name || !editor.server.command.trim()) {
      setNote("Name and command are required.");
      return;
    }
    if (servers.some((server) => server.name === name && server.name !== editor.originalName)) {
      setNote("Use a unique server name.");
      return;
    }
    if (!editor.everyRuntime && (editor.server.runtimeIds?.length ?? 0) === 0) {
      setNote("Choose at least one runtime, or use every runtime.");
      return;
    }
    if (!editor.everyTool && (editor.server.includeTools?.length ?? 0) === 0) {
      setNote("Test the server and choose at least one tool, or use every tool.");
      return;
    }
    const environment = parsedEnv(editor.envText);
    if (environment.invalid) {
      setNote("Environment entries use NAME=value, one per line.");
      return;
    }
    setSaving(true);
    setNote("Saving…");
    try {
      await store.setMcpServers(replaceServer(servers, editor));
      setEditor(null);
      setNote(`${name} saved.`);
    } catch {
      setNote("Workhorse could not save this MCP server.");
    } finally {
      setSaving(false);
    }
  };

  const probe = async (server: McpServerConfig) => {
    setProbing(server.name);
    setNote("Starting server…");
    const result = await store.probeMcpServer(server.name);
    setProbing(null);
    setNote(result.message);
    if (!result.ok) return;
    const next = editorFor(server);
    setEditor({
      ...next,
      discoveredTools: result.tools,
      server: { ...next.server, includeTools: next.everyTool ? undefined : next.server.includeTools?.filter((tool) => result.tools.includes(tool)) ?? [] },
    });
  };

  if (editor) {
    return (
      <section className="mcp-settings" aria-label="MCP server editor">
        <div className="link-head">
          <div>
            <strong>{editor.originalName ? `Edit ${editor.originalName}` : "Add MCP server"}</strong>
            <p className="row-meta">Workhorse starts this command directly. Environment values remain hidden.</p>
          </div>
          <button className="tiny" type="button" onClick={() => { setEditor(null); setNote(""); }}>Cancel</button>
        </div>
        <div className="bot-form-grid mcp-form-grid">
          <label>
            <span>Name</span>
            <input value={editor.server.name} onChange={(event) => patchServer({ name: event.target.value })} placeholder="codebase-memory" />
          </label>
          <label>
            <span>Command</span>
            <input value={editor.server.command} onChange={(event) => patchServer({ command: event.target.value })} placeholder="codebase-memory-mcp" />
          </label>
          <label className="mcp-wide-field">
            <span>Arguments · one per line</span>
            <textarea value={editor.argsText} onChange={(event) => setEditor((current) => current ? { ...current, argsText: event.target.value } : current)} rows={3} />
          </label>
          <label className="mcp-wide-field">
            <span>Environment · NAME=value, one per line</span>
            <textarea
              value={editor.envText}
              onChange={(event) => setEditor((current) => current ? { ...current, envText: event.target.value } : current)}
              rows={3}
              autoComplete="off"
              placeholder="GITHUB_TOKEN=…"
            />
            <em>Values are write-only here and move to the OS-encrypted credential store after Save.</em>
          </label>
        </div>
        {Object.keys({ ...(editor.server.envCredentialIds ?? {}), ...(editor.server.env ?? {}) }).length > 0 ? (
          <div className="mcp-env-names">
            <span className="row-meta">Saved environment names</span>
            <div className="actions">
              {Object.keys({ ...(editor.server.envCredentialIds ?? {}), ...(editor.server.env ?? {}) }).map((name) => (
                <button
                  className={editor.removedEnv.includes(name) ? "tiny danger" : "tiny"}
                  type="button"
                  key={name}
                  onClick={() => setEditor((current) => current ? {
                    ...current,
                    removedEnv: current.removedEnv.includes(name)
                      ? current.removedEnv.filter((item) => item !== name)
                      : [...current.removedEnv, name],
                  } : current)}
                >
                  {editor.removedEnv.includes(name) ? `Keep ${name}` : `Remove ${name}`}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <fieldset className="mcp-scope">
          <legend>Available to</legend>
          <label className="check-row">
            <input type="checkbox" checked={editor.everyRuntime} disabled={!editor.everyTool} onChange={(event) => setEditor((current) => current ? { ...current, everyRuntime: event.target.checked } : current)} />
            <span>Every runtime</span>
          </label>
          {!editor.everyRuntime ? (
            <div className="mcp-check-grid">
              {runtimes.map((runtime) => (
                <label className="check-row" key={runtime.id}>
                  <input type="checkbox" disabled={!editor.everyTool && !isCustomRuntime(runtime.id)} checked={(editor.server.runtimeIds ?? []).includes(runtime.id)} onChange={() => toggleRuntime(runtime.id)} />
                  <span>{runtime.label}</span>
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="mcp-scope">
          <legend>Tools</legend>
          <label className="check-row">
            <input type="checkbox" checked={editor.everyTool} onChange={(event) => setEveryTool(event.target.checked)} />
            <span>Use every tool this server reports</span>
          </label>
          {!editor.everyTool && editor.discoveredTools.length > 0 ? (
            <div className="mcp-check-grid">
              {editor.discoveredTools.map((tool) => (
                <label className="check-row" key={tool}>
                  <input type="checkbox" checked={(editor.server.includeTools ?? []).includes(tool)} onChange={() => toggleTool(tool)} />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
          ) : !editor.everyTool ? <p className="row-meta">Test the server to choose its tools.</p> : null}
        </fieldset>

        {note ? <p className="row-meta">{note}</p> : null}
        <div className="actions">
          <button className="tiny primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="mcp-settings" aria-label="MCP servers">
      <div className="link-head">
        <div>
          <strong>MCP tools</strong>
          <p className="row-meta">Connect tool servers, then choose which runtimes can use them. A restricted tool list is available only to custom HTTP models.</p>
        </div>
        <button className="tiny" type="button" onClick={() => { setEditor(editorFor()); setNote(""); }}>Add server</button>
      </div>
      {servers.length === 0 ? <p className="row-meta">No MCP servers connected.</p> : (
        <ul className="mcp-server-list">
          {servers.map((server) => {
            const restricted = server.includeTools !== undefined;
            const target = restricted
              ? "Custom HTTP only"
              : server.runtimeIds === undefined
                ? "Every runtime"
                : `${server.runtimeIds.length} runtime${server.runtimeIds.length === 1 ? "" : "s"}`;
            const tools = server.includeTools === undefined ? "every tool" : `${server.includeTools.length} tool${server.includeTools.length === 1 ? "" : "s"}`;
            return (
              <li className="mcp-server-row" key={server.name}>
                <div>
                  <strong>{server.name}</strong>
                  <span className="row-meta">{server.enabled === false ? "Off" : "On"} · {target} · {tools}</span>
                </div>
                <div className="actions">
                  <button className="tiny" type="button" onClick={() => void store.setMcpServers(servers.map((item) => item.name === server.name ? { ...item, enabled: item.enabled !== false ? false : undefined } : item))}>
                    {server.enabled === false ? "Enable" : "Disable"}
                  </button>
                  <button className="tiny" type="button" disabled={probing === server.name} onClick={() => void probe(server)}>{probing === server.name ? "Testing…" : "Test"}</button>
                  <button className="tiny" type="button" onClick={() => { setEditor(editorFor(server)); setNote(""); }}>Edit</button>
                  {confirmDelete === server.name ? (
                    <button className="tiny danger" type="button" onClick={() => { void store.setMcpServers(servers.filter((item) => item.name !== server.name)); setConfirmDelete(null); setNote(`${server.name} deleted.`); }}>Delete for good</button>
                  ) : (
                    <button className="tiny" type="button" onClick={() => setConfirmDelete(server.name)}>Delete</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {note ? <p className="row-meta">{note}</p> : null}
    </section>
  );
}
