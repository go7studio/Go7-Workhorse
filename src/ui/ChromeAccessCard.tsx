import { CHROME_ACCESS_QUESTION } from "../lib/browser-access";
import { useStore } from "../lib/store";

/**
 * In-chat Chrome access prompt for browser tools.
 * Allow launches installed Chrome on a desk-owned profile. Decline starts the headless session.
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
        <strong>{CHROME_ACCESS_QUESTION}</strong>
        <span className="permission-detail">
          {label} asked for a browser. Allow controls installed Chrome with navigate, snapshot, click, fill, screenshot, and console, in a profile under Workhorse. Your Chrome profile is used only when this chat explicitly asks for it. Decline keeps a headless browser for this chat. Always permission does not attach your Chrome profile.
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
