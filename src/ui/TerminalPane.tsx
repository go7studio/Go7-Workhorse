import { useEffect, useRef, useState } from "react";

const MAX_OUTPUT = 120_000;

export function TerminalPane({
  sessionId,
  cwd,
  onClose,
  initialCommand,
}: {
  sessionId: string;
  cwd: string;
  onClose: () => void;
  /** Run this as soon as the shell is up, so a login needs no typing. */
  initialCommand?: string;
}) {
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [message, setMessage] = useState("");
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const off = window.workhorse?.onTerminalEvent?.((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "output") {
        setOutput((current) => `${current}${event.data}`.slice(-MAX_OUTPUT));
      } else {
        setMessage(`Shell exited${event.code === null ? "" : ` (${event.code})`}.`);
      }
    });
    void window.workhorse?.terminalStart?.(sessionId, cwd).then((result) => {
      if (!result.ok) {
        setMessage(result.message || "Could not start terminal.");
        return;
      }
      if (initialCommand) {
        setOutput((current) => `${current}> ${initialCommand}\n`.slice(-MAX_OUTPUT));
        void window.workhorse?.terminalWrite?.(sessionId, initialCommand);
      }
    });
    return () => off?.();
  }, [sessionId, cwd, initialCommand]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [output]);

  const run = () => {
    const text = command.trim();
    if (!text) return;
    setOutput((current) => `${current}> ${text}\n`.slice(-MAX_OUTPUT));
    setCommand("");
    void window.workhorse?.terminalWrite?.(sessionId, text).then((result) => {
      if (!result.ok) setMessage(result.message || "Could not write to terminal.");
    });
  };

  return (
    <section className="terminal-pane" aria-label="Chat terminal">
      <header>
        <div>
          <strong>Terminal</strong>
          <span title={cwd}>{cwd}</span>
        </div>
        <div className="actions">
          <button
            className="tiny"
            type="button"
            onClick={() => {
              void window.workhorse?.terminalStop?.(sessionId);
              setMessage("Shell stopped.");
            }}
          >
            Stop
          </button>
          <button className="tiny" type="button" onClick={onClose}>Close</button>
        </div>
      </header>
      <pre ref={scroller}>{output || "Shell ready.\n"}</pre>
      {message ? <p>{message}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <span aria-hidden="true">›</span>
        <input
          autoFocus
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Run a command"
          aria-label="Terminal command"
        />
      </form>
    </section>
  );
}
