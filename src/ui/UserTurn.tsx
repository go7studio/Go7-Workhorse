import { memo, useEffect, useRef, useState } from "react";
import { splitGoalCommand } from "../lib/commands";
import { attachmentLabel, groupAttachments, imageSrc, isPicture } from "../lib/images";
import { peerPromptParts } from "../lib/session-bridge";
import { useStoreSelector } from "../lib/store";
import type { ChatImage, ChatMessage } from "../lib/types";
import { ImageZoom } from "./ImageZoom";
import { useMediaPaintReady } from "./MediaPaint";
import { MessageBody } from "./MessageBody";
import { copyText } from "../lib/copy-text";
import { TimeStamp } from "./TimeStamp";
import { TurnActions } from "./TurnActions";

function DeferredChatImage({ image }: { image: ChatImage }) {
  const ready = useMediaPaintReady();
  if (!ready) return <span className="say-image-pending" aria-hidden="true" />;
  return <ImageZoom className="say-image" src={imageSrc(image)} alt={image.name} />;
}

type UserTurnStore = {
  editing: boolean;
  requestEditMessage: (id: string) => void;
  clearEditMessage: () => void;
  resendFrom: (id: string, text: string) => void;
  forkFrom: (id: string) => void;
};

const sameUserTurnStore = (left: UserTurnStore, right: UserTurnStore) =>
  left.editing === right.editing &&
  left.requestEditMessage === right.requestEditMessage &&
  left.clearEditMessage === right.clearEditMessage &&
  left.resendFrom === right.resendFrom &&
  left.forkFrom === right.forkFrom;

export const UserTurn = memo(function UserTurn({ message, readOnly = false }: { message: ChatMessage; readOnly?: boolean }) {
  const store = useStoreSelector((desk) => ({
    editing: desk.editMessageId === message.id,
    requestEditMessage: desk.requestEditMessage,
    clearEditMessage: desk.clearEditMessage,
    resendFrom: desk.resendFrom,
    forkFrom: desk.forkFrom,
  }), sameUserTurnStore);
  const editing = store.editing;
  const [draft, setDraft] = useState(message.text);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(message.text);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
      el.setSelectionRange(el.value.length, el.value.length);
});
  }, [editing, message.text]);

  if (editing && !readOnly) {
    return (
      <article className="turn user chat">
        <form
          className="prompt-edit"
          onSubmit={(event) => {
            event.preventDefault();
            store.resendFrom(message.id, draft);
          }}
        >
          <textarea
            ref={field}
            value={draft}
            aria-label="Edit prompt"
            onChange={(event) => {
              setDraft(event.target.value);
              const el = event.currentTarget;
              el.style.height = "0px";
              el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                store.clearEditMessage();
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                store.resendFrom(message.id, draft);
              }
            }}
          />
          <div className="prompt-edit-actions">
            <button type="button" onClick={() => store.clearEditMessage()}>
              Cancel
            </button>
            <button className="resend" type="submit" disabled={!draft.trim() && !(message.images && message.images.length)}>
              Resend
            </button>
          </div>
        </form>
      </article>
    );
  }

  const peer = peerPromptParts(message);
  const visible = peer?.text ?? message.text;
  const goal = splitGoalCommand(visible);
  return (
    <article className={`turn user chat${peer ? " peer" : ""}`}>
      <div className="say-stack">
        <TimeStamp at={message.createdAt} />
        <div className="say">
          {peer ? <span className="peer-from">From {peer.fromTitle}</span> : null}
          {message.images && message.images.length > 0 && (
            <div className="say-images">
              {groupAttachments(message.images).map((group) =>
                group.type === "folder" ? (
                  <span
                    key={`folder:${group.name}`}
                    className="say-file folder"
                    title={`${group.name} · ${group.files.length} files`}
                  >
                    {group.name}
                    <em>
                      {group.files.length} file{group.files.length === 1 ? "" : "s"}
                    </em>
                  </span>
                ) : isPicture(group.file) ? (
                  <DeferredChatImage key={group.file.id} image={group.file} />
                ) : (
                  <span key={group.file.id} className="say-file" title={group.file.name}>
                    {group.file.name}
                    <em>{attachmentLabel(group.file)}</em>
                  </span>
                ),
              )}
            </div>
          )}
          {goal ? (
            <p className="command-line">
              <span className="chat-command">{goal.name}</span>
              {goal.rest}
            </p>
          ) : visible.trim() ? (
            <MessageBody text={visible} />
          ) : null}
        </div>
      </div>
      <TurnActions
        actions={
          readOnly
            ? [{ id: "copy", label: "Copy", run: () => copyText(peer?.text ?? message.text) }]
            : [
                ...(peer ? [] : [{ id: "edit", label: "Edit", run: () => store.requestEditMessage(message.id) }]),
                { id: "copy", label: "Copy", run: () => copyText(peer?.text ?? message.text) },
                { id: "fork", label: "Fork", run: () => store.forkFrom(message.id) },
              ]
        }
      />
    </article>
  );
});
