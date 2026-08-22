import { useEffect, useState } from "react";
import { useStore } from "../lib/store";

export function GrokBotWakeSetup() {
  const store = useStore();
  const status = store.grokBotWakeStatus;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (status?.configured) setEditing(false);
  }, [status?.configured]);

  const connect = () => {
    setBusy(true);
    setNote("");
    void store.saveGrokBotWake({ url, key }).then((next) => {
      setBusy(false);
      setNote(next.message);
      if (next.configured) {
        setUrl("");
        setKey("");
        setEditing(false);
      }
    });
  };

  return (
    <section className={`grok-bot-wake${status?.ready ? " ready" : ""}`}>
      <div className="grok-bot-wake-head">
        <div>
          <strong>{status?.ready ? "Instant replies ready" : "Instant replies (optional)"}</strong>
          <span>
            {status?.ready
              ? "Workhorse can wake Grok Bot when you send a message."
              : "Grok Bot works without this. Add its wake connection later for quick replies."}
          </span>
        </div>
        {editing ? (
          <button className="tiny" type="button" onClick={() => setEditing(false)}>
            Hide
          </button>
        ) : status?.configured ? (
          <span className="grok-bot-wake-state" aria-label="Instant replies ready">
            <i aria-hidden="true" />
            Ready
          </span>
        ) : (
          <button className="tiny" type="button" onClick={() => setEditing(true)}>
            Set up
          </button>
        )}
      </div>

      {!editing && status?.configured ? (
        <div className="grok-bot-wake-done">
          <p>{note || status.message}</p>
          <div className="actions">
            <button className="tiny" type="button" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </div>
      ) : editing ? (
        <form
          className="grok-bot-wake-form"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <details className="grok-bot-wake-help" open>
            <summary>2-minute Grok Bot setup</summary>
            <p>
              Choose this bot in Grok Bot. Ask it to create an active Workhorse routine that runs
              <strong> When a webhook fires</strong>. Open that trigger, then copy <strong>POST to</strong> and
              <strong> key</strong> here. Never send either value in chat.
            </p>
            <a
              className="grok-bot-wake-guide"
              href="https://github.com/go7studio/Go7-Workhorse/blob/main/docs/GROK-BOT.md#instant-chat-walkthrough"
              target="_blank"
              rel="noreferrer"
            >
              Open the walkthrough
            </a>
          </details>
          <div className="grok-bot-wake-fields">
            <label className="field">
              <span>POST to</span>
              <input
                type="password"
                value={url}
                placeholder="Paste the webhook URL"
                autoComplete="off"
                spellCheck={false}
                aria-label="Grok Bot POST to URL"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span>key</span>
              <input
                type="password"
                value={key}
                placeholder="Paste the sender key"
                autoComplete="off"
                spellCheck={false}
                aria-label="Grok Bot sender key"
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
          </div>
          <div className="grok-bot-wake-connect">
            <p className="row-meta">{note || "Saved privately on this computer. Hidden after Connect."}</p>
            <button className="primary" type="submit" disabled={busy || !url.trim() || !key.trim()}>
              {busy ? "Saving…" : "Connect instant replies"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
