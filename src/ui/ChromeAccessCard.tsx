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
        <span className="permission-detail">
          {label} asked for a browser. This chat keeps that allow after a restart. All chats allows every chat and stays on after a restart. Both use installed Chrome with navigate, snapshot, click, fill, screenshot, and console, in a profile under Workhorse. Your Chrome profile is used only when a chat explicitly asks for it. Decline stays on this chat and keeps a headless browser. Always permission does not attach your Chrome profile.
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
        </div>
      </div>
    </div>
  );
}
