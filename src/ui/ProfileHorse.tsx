import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { formatTokens, profileHorseBlobs, profileHorseInks, profileHorseTip, profileHorseVisualInks } from "../lib/usage";
import { useStore } from "../lib/store";

export function ProfileHorse() {
  const { usage, settings } = useStore();
  const inks = profileHorseInks(usage ?? [], settings);
  const visual = profileHorseVisualInks(inks);
  const blobs = profileHorseBlobs(visual);
  const tip = profileHorseTip(inks);

  return (
    <div className="profile-horse-wrap" tabIndex={0} aria-label={`${tip.title}. ${tip.blurb}`}>
      <div className="profile-horse" style={{ ["--horse-mark" as string]: `url("${horseMark}")` }}>
        {blobs.map((blob) => (
          <i
            key={blob.key}
            className="profile-horse-blob"
            style={{
              background: blob.color,
              left: `${blob.left}%`,
              top: `${blob.top}%`,
              animationDelay: `${blob.delay}s`,
              animationDuration: `${blob.duration}s`,
              ["--blob-size" as string]: `${blob.size}%`,
              ["--drift-x" as string]: `${blob.driftX}%`,
              ["--drift-y" as string]: `${blob.driftY}%`,
            }}
          />
        ))}
      </div>
      <div className="profile-horse-tip" role="tooltip">
        <strong>Your Workhorse</strong>
        <span>{tip.blurb}</span>
        {tip.parts.length > 0 ? (
          <ul>
            {tip.parts.map((part) => (
              <li key={part.key}>
                <span>
                  <i className="dot" style={{ background: part.color }} />
                  {part.label}
                </span>
                <em>
                  {Math.round(part.share * 100)}%
                  <small>{formatTokens(part.tokens)} tokens</small>
                </em>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
