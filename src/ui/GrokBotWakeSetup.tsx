import { useEffect, useState } from "react";
import { useStore } from "../lib/store";

export function GrokBotWakeSetup() {
  const store = useStore();
  const status = store.grokBotWakeStatus;
  const [editing, setEditing] = useState(true);
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
          <strong>{status?.ready ? "Instant chats connected" : "Finish instant chat access"}</strong>
          <span>
            {status?.ready
              ? "Workhorse can wake Grok Bot when you send a message."
              : "Adding the bot is separate. This connection wakes it immediately for a reply."}
          </span>
        </div>
        <span className="grok-bot-wake-state" aria-label={status?.ready ? "Connected" : "Not connected"}>
          <i aria-hidden="true" />
          {status?.ready ? "Ready" : status?.configured ? "Saved" : "Needed"}
        </span>
      </div>

      {!editing && status?.configured ? (
        <div className="grok-bot-wake-done">
          <p>{note || status.message}</p>
          <div className="actions">
            <button className="tiny" type="button" onClick={() => void store.refreshGrokBotWake()}>
              Recheck
            </button>
            <button className="tiny" type="button" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </div>
      ) : (
        <form
          className="grok-bot-wake-form"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <details className="grok-bot-wake-help" open={!status?.configured}>
            <summary>Where to find the URL and key</summary>
            <p>
              In Grok Bot, choose the bot you are adding. Create an active routine named Workhorse with
              <strong> When a webhook fires</strong>. Open <strong>Webhook</strong>, then copy its public URL and key here.
              Keep the key out of chat.
            </p>
          </details>
          <div className="grok-bot-wake-fields">
            <label className="field">
              <span>Webhook URL</span>
              <input
                type="url"
                value={url}
                placeholder="https://…/webhook/…"
                autoComplete="off"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Webhook key</span>
              <input
                type="password"
                value={key}
                placeholder="Stored on this computer"
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
          </div>
          <div className="grok-bot-wake-connect">
            <p className="row-meta">{note || status?.message || "Checking this computer…"}</p>
            <button className="primary" type="submit" disabled={busy || !url.trim() || !key.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
