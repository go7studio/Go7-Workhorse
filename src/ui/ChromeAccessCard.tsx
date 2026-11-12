import { useStore } from "../lib/store";

/**
 * In-chat Chrome access prompt for browser tools.
 * Allow uses Piper's Chrome path. Decline starts a headless desk-owned session.
 * Not a Settings tab.
 */
export function ChromeAccessCard() {
  const { chromeAccessPrompt, answerChromeAccess, sessions } = useStore();
  if (!chromeAccessPrompt?.sessionId) return null;
  const session = sessions.find((item) => item.id === chromeAccessPrompt.sessionId);
  const label = chromeAccessPrompt.name?.trim() || session?.title || "This chat";

  return (
    <div className="palette-overlay permission-overlay" role="dialog" aria-modal="true">
      <div className="permission-card">
        <div className="session-who">
          <span className="eyebrow">Browser · Chrome access</span>
        </div>
        <strong>{label} wants Chrome access</strong>
        <span className="permission-detail">
          Allow uses installed Chrome in a desk-owned profile. Decline starts a headless background browser for this chat — not your login session, and not a desktop takeover.
        </span>
        <div className="actions">
          <button
            className="tiny deny"
            type="button"
            onClick={() => answerChromeAccess(chromeAccessPrompt.sessionId, "declined")}
          >
            Decline
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => answerChromeAccess(chromeAccessPrompt.sessionId, "granted")}
          >
            Allow Chrome
          </button>
        </div>
      </div>
    </div>
  );
}
