import { chromeAccessDecision, chromeAccessPromptLabel } from "../lib/background-browser";
import { CHROME_ACCESS_QUESTION } from "../lib/browser-access";
import { useStore } from "../lib/store";

/**
 * In-chat Chrome access prompt for browser tools.
 * This chat keeps the allow on that chat. All chats allows every chat.
 * Both stay after a restart. Decline starts the headless session.
 */
export function ChromeAccessCard() {
  const { chromeAccessPrompt, answerChromeAccess, sessions, settings } = useStore();
  if (!chromeAccessPrompt?.sessionId) return null;
  const session = sessions.find((item) => item.id === chromeAccessPrompt.sessionId);
  if (chromeAccessDecision({ sessionAccess: session?.chromeAccess, deskAlways: settings.chromeAlways }) !== "unset") {
    return null;
  }
  const label = chromeAccessPromptLabel(session?.title);

  return (
    <div className="palette-overlay permission-overlay" role="dialog" aria-modal="true">
      <div className="permission-card">
        <div className="session-who">
          <span className="eyebrow">Browser · Chrome access</span>
        </div>
        <strong>{CHROME_ACCESS_QUESTION}</strong>
        <span className="permission-detail">{label}</span>
        <div className="actions">
          <button
            className="primary"
            type="button"
            onClick={() => answerChromeAccess(chromeAccessPrompt.sessionId, "granted", "session")}
          >
            This chat
          </button>
          <button
            type="button"
            onClick={() => answerChromeAccess(chromeAccessPrompt.sessionId, "granted", "always")}
          >
            All chats
          </button>
          <button
            className="tiny deny"
            type="button"
            onClick={() => answerChromeAccess(chromeAccessPrompt.sessionId, "declined")}
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
