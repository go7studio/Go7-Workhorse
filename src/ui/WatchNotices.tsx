import { memo, useEffect, useMemo, useRef } from "react";
import { useStoreSelector } from "../lib/store";
import { sameWatchDesk, selectWatchDesk } from "../lib/store-select";
import {
  evaluateWatchHold,
  isDesktopWatchNotice,
  summarizeWatchNotices,
  watchBarDetail,
  watchBarTitle,
  watchKeyForSession,
  watchLocksKey,
} from "../lib/watch";

function vendorAskTitle(vendor: { name: string; status?: string }): string {
  if (vendor.status === "disabled") return `${vendor.name} is turned off`;
  if (vendor.status === "spent") return `${vendor.name} is out for the week`;
  if (vendor.status === "day_bank") return `${vendor.name} used its daily bank`;
  return `Use ${vendor.name} in this chat?`;
}

export const WatchBanners = memo(function WatchBanners({
  onSwitchModel,
  setupOpen = false,
}: {
  onSwitchModel?: () => void;
  setupOpen?: boolean;
} = {}) {
  const store = useStoreSelector(selectWatchDesk, sameWatchDesk);
  const session = store.session;
  const ownKey = session ? watchKeyForSession(session) : null;
  const pending = store.watchHold && session && store.watchHold.sessionId === session.id ? store.watchHold : null;
  const live = useMemo(() => {
    if (!session) return null;
    return evaluateWatchHold({
      session,
      settings: store.settings,
      plans: {
        grok: store.grokPlan,
        codex: store.codexPlan,
        claude: store.claudePlan,
        cursor: store.cursorPlan,
        custom: store.customPlans,
      },
      permits: store.watchPermits,
      usage: store.usage,
      dayMarks: store.watchDayMarks,
    });
  }, [
    session,
    store.settings,
    store.grokPlan,
    store.codexPlan,
    store.claudePlan,
    store.cursorPlan,
    store.customPlans,
    store.watchPermits,
    store.usage,
    store.watchDayMarks,
  ]);
  const hold = pending ?? (live
    ? {
        ...live,
        sessionId: session?.id ?? "",
        text: "",
      }
    : null);
  const notices = setupOpen
    ? []
    : store.watchNotices.filter((notice) => {
        if (ownKey && notice.key !== ownKey) return false;
        if (hold && notice.key === hold.key && (notice.kind === "daily" || notice.kind === "spent")) return false;
        return true;
      });
  const noticeSummary = summarizeWatchNotices(notices);

  const vendorAsk =
    setupOpen
      ? null
      : store.pending.find((item) => item.kind === "vendor" && (!session || item.sessionId === session.id));

  const showHold = Boolean(hold) && !setupOpen;
  if (setupOpen || (!showHold && notices.length === 0 && !vendorAsk)) return null;
  return (
    <div className="watch-banners" role="status">
      {vendorAsk?.vendor ? (
        <div className="watch-hold-bar hold" role="dialog" aria-label={`${vendorAsk.vendor.name} override`}>
          <div className="watch-toast-copy">
            <strong>{vendorAskTitle(vendorAsk.vendor)}</strong>
            <span>{vendorAsk.detail}</span>
          </div>
          <div className="actions">
            <button className="tiny deny" type="button" onClick={() => store.answerPermission(vendorAsk.id, "deny")}>
              Deny
            </button>
            <button className="primary" type="button" onClick={() => store.answerPermission(vendorAsk.id, "session")}>
              {vendorAsk.vendor.status === "disabled"
                ? `Turn ${vendorAsk.vendor.name} on`
                : `Allow ${vendorAsk.vendor.name} this chat`}
            </button>
          </div>
        </div>
      ) : null}
      {hold && showHold ? (
        <div className="watch-hold-bar">
          <div className="watch-toast-copy">
            <strong>{watchBarTitle(hold)}</strong>
            <span>{watchBarDetail({ reason: hold.reason, pending: Boolean(pending?.text.trim()) })}</span>
          </div>
          <div className="actions">
            {onSwitchModel ? (
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  if (pending) store.denyWatchHold();
                  onSwitchModel();
                }}
              >
                Switch model
              </button>
            ) : null}
            <button className="primary" type="button" onClick={() => store.permitWatchHold("conversation")}>
              Allow this chat
            </button>
            {pending?.text.trim() ? (
              <button className="ghost" type="button" onClick={() => store.permitWatchHold("once")}>
                Send once
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {noticeSummary ? (
        <div key={notices.map((notice) => notice.id).join(":")} className={`watch-toast ${noticeSummary.tone}`}>
          <div className="watch-toast-copy">
            <strong>{noticeSummary.title}</strong>
            <span>{noticeSummary.detail}</span>
          </div>
          <div className="actions">
            <button
              className="tiny"
              type="button"
              onClick={() => notices.forEach((notice) => store.dismissWatchNotice(notice))}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export function WatchNotices() {
  const store = useStoreSelector(selectWatchDesk, sameWatchDesk);
  const session = store.session;
  const seenDesktop = useRef(new Set<string>());

  useEffect(() => {
    if (!store.settings.watch?.desktopNotify) return;
    const watch = store.settings.watch;
    const desktopNotices = store.watchNotices.filter(
      (notice) => isDesktopWatchNotice(notice) && watchLocksKey(watch, notice.key) && !seenDesktop.current.has(notice.id),
    );
    for (const notice of desktopNotices) {
      seenDesktop.current.add(notice.id);
    }
    const desktopSummary = summarizeWatchNotices(desktopNotices);
    if (desktopSummary) {
      void window.workhorse?.notifyDesktop?.({ title: desktopSummary.title, body: desktopSummary.detail });
    }
    for (const item of store.pending) {
      if ((item.kind !== "vendor" && item.kind !== "elevate") || seenDesktop.current.has(item.id)) continue;
      seenDesktop.current.add(item.id);
      const title =
        item.kind === "vendor" && item.vendor
          ? vendorAskTitle(item.vendor)
          : item.kind === "vendor"
            ? "Allow that vendor this chat?"
            : "Needs more access";
      void window.workhorse?.notifyDesktop?.({ title, body: item.detail });
    }
  }, [store.settings.watch, store.watchNotices, store.pending]);

  return (
    <>
      {!session && <WatchBanners />}
    </>
  );
}
