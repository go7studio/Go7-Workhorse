import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  canStopHere,
  ceilingEvent,
  foldTeamJournal,
  inboxOwnerEvent,
  joinTeam,
  livePresence,
  permissionAnsweredEvent,
  resolveWorkshopGrant,
  seatOf,
  startTeam,
  syncTeamProject,
  teamCeilingStop,
  teamLocator,
  teamProjectTotal,
  workshopGrantEvent,
  workshopGrantFor,
  type PresenceBeat,
  type TeamCard,
  type TeamCeiling,
  type TeamEvent,
  type TeamLocal,
  type TeamTotal,
  type TeamView,
} from "./team";
import type { AppState, PermissionRequest, Project, Session } from "./types";

/** How often a team project reads its journal and beats its presence. */
export const TEAM_SYNC_MS = 4_000;

export type TeamSnapshot = {
  projectId: string;
  journalId: string;
  members: string[];
  inboxOwner: string | null;
  waiting: TeamCard[];
  presence: PresenceBeat[];
  total: TeamTotal;
  ceiling: TeamCeiling | null;
  grants: Array<{ pack: string; host: string; seat: string; ready: boolean; message?: string }>;
  locator: string;
  error?: string;
};

export type TeamResult = { ok: boolean; message: string; locator?: string };

export type TeamDeskApi = {
  device: string | null;
  seat: string;
  snapshots: Record<string, TeamSnapshot>;
  share: (projectId: string) => Promise<TeamResult>;
  join: (locator: string) => Promise<TeamResult>;
  handInbox: (projectId: string, to: string) => Promise<TeamResult>;
  takeInbox: (projectId: string) => Promise<TeamResult>;
  setCeiling: (projectId: string, usd: number | null) => Promise<TeamResult>;
  shareWorkshopGrant: (projectId: string, packId: string) => Promise<TeamResult>;
  /** Why the next send in this chat must stop, or null. */
  sendStop: (sessionId: string) => string | null;
  canStop: (sessionId: string) => boolean;
  noteAnswer: (request: PermissionRequest, answer: "once" | "session" | "deny") => void;
};

type Held = { view: TeamView; beats: PresenceBeat[] };

/**
 * Take a sync result computed from one snapshot onto a desk that may have
 * moved since. A chat that changed in between keeps its newer self and is
 * synced next pass; that is how a streaming turn is never rewritten.
 */
export function landTeamSync(
  current: AppState,
  snapshot: readonly Session[],
  projectId: string,
  result: { sessions: Session[]; baseline: NonNullable<Project["team"]>["baseline"] },
): AppState {
  const before = new Map(snapshot.map((session) => [session.id, session]));
  const synced = new Map(result.sessions.map((session) => [session.id, session]));
  const sessions = current.sessions.map((session) => {
    const next = synced.get(session.id);
    if (!next || next === session) return session;
    return before.get(session.id) === session ? next : session;
  });
  for (const session of result.sessions) {
    if (!before.has(session.id) && !sessions.some((item) => item.id === session.id)) sessions.push(session);
  }
  const projects = current.projects.map((project) =>
    project.id === projectId && project.team ? { ...project, team: { ...project.team, baseline: result.baseline } } : project,
  );
  return { ...current, sessions, projects };
}

export function useTeamDesk(input: {
  ready: boolean;
  stateRef: MutableRefObject<AppState>;
  setState: Dispatch<SetStateAction<AppState>>;
}): TeamDeskApi {
  const { ready, stateRef, setState } = input;
  const [device, setDevice] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, TeamSnapshot>>({});
  const held = useRef<Record<string, Held>>({});
  const deviceRef = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!ready) return;
    void window.workhorse?.teamDevice?.().then((id) => {
      deviceRef.current = id;
      setDevice(id);
    });
  }, [ready]);

  const local = useCallback((): TeamLocal | null => {
    const id = deviceRef.current;
    if (!id) return null;
    const state = stateRef.current;
    return {
      device: id,
      seat: seatOf(state.settings.profile),
      now: Date.now(),
      mode: state.lastModel.mode ?? "ask",
      sandbox: state.lastModel.sandbox,
    };
  }, [stateRef]);

  const syncProject = useCallback(
    async (projectId: string) => {
      const api = window.workhorse;
      const me = local();
      const project = stateRef.current.projects.find((item) => item.id === projectId);
      const link = project?.team;
      if (!api?.teamRead || !api.teamAppend || !me || !link) return;
      const read = await api.teamRead(link.folder, link.journalId);
      const state = stateRef.current;
      const snapshot = state.sessions;
      const result = syncTeamProject(state, projectId, read.events, { ...me, now: Date.now() });
      if (!result) return;
      if (result.append.length > 0) await api.teamAppend(link.folder, link.journalId, me.device, result.append);
      if (result.changed) setState((current) => landTeamSync(current, snapshot, projectId, result));
      const active = state.activeSessionId;
      const beat: PresenceBeat = {
        device: me.device,
        seat: me.seat,
        chatId: active && snapshot.some((session) => session.id === active && session.projectId === projectId) ? active : null,
        at: Date.now(),
      };
      void api.teamPresence?.(link.folder, link.journalId, beat);
      const beats = [...read.presence.filter((item) => item.device !== me.device), beat];
      held.current[projectId] = { view: result.view, beats };
      const hosts = state.settings.localCompute?.hosts ?? [];
      const snap: TeamSnapshot = {
        projectId,
        journalId: link.journalId,
        members: result.view.members,
        inboxOwner: result.view.inbox.owner,
        waiting: result.view.waiting,
        presence: livePresence(beats, Date.now()),
        total: teamProjectTotal({ view: result.view, beats, now: Date.now(), device: me.device, seat: me.seat, projectId, localUsage: state.usage }),
        ceiling: result.view.ceiling,
        grants: [...result.view.grants.values()].map((grant) => {
          const here = resolveWorkshopGrant(grant, hosts);
          return { pack: grant.pack, host: grant.host, seat: grant.seat, ready: here.status === "ready", ...(here.status === "no-host" ? { message: here.message } : {}) };
        }),
        locator: teamLocator({ journal: link.journalId, project: { id: projectId, name: project.name }, from: me.seat, device: me.device }),
        ...(read.error ? { error: read.error } : {}),
      };
      setSnapshots((current) => ({ ...current, [projectId]: snap }));
    },
    [local, setState, stateRef],
  );

  const syncAll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (const project of stateRef.current.projects) if (project.team) await syncProject(project.id);
    } finally {
      busy.current = false;
    }
  }, [stateRef, syncProject]);

  useEffect(() => {
    if (!ready || !device) return;
    void syncAll();
    const timer = window.setInterval(() => void syncAll(), TEAM_SYNC_MS);
    return () => window.clearInterval(timer);
  }, [ready, device, syncAll]);

  const appendOne = useCallback(
    async (projectId: string, made: TeamEvent | null | { error: string } | { event: TeamEvent }, done: string): Promise<TeamResult> => {
      const link = stateRef.current.projects.find((item) => item.id === projectId)?.team;
      const me = local();
      if (!link || !me) return { ok: false, message: "This project is not on a team." };
      if (!made) return { ok: false, message: "That could not be written." };
      if ("error" in made) return { ok: false, message: made.error };
      const item = "event" in made ? made.event : made;
      await window.workhorse?.teamAppend?.(link.folder, link.journalId, me.device, [item]);
      await syncProject(projectId);
      return { ok: true, message: done };
    },
    [local, stateRef, syncProject],
  );

  const viewOf = (projectId: string): TeamView => held.current[projectId]?.view ?? foldTeamJournal([]);

  const share = useCallback(
    async (projectId: string): Promise<TeamResult> => {
      const me = local();
      const project = stateRef.current.projects.find((item) => item.id === projectId);
      if (!me || !project) return { ok: false, message: "Open the desktop app to share a project." };
      if (project.team) {
        const locator = snapshots[projectId]?.locator;
        return { ok: true, message: "Already shared.", ...(locator ? { locator } : {}) };
      }
      const picked = await window.workhorse?.teamPickFolder?.();
      if (!picked) return { ok: false, message: "Pick a folder both computers can see, such as a synced folder." };
      const started = startTeam({ project, folder: picked.path, local: me });
      if ("error" in started) return { ok: false, message: started.error };
      await window.workhorse?.teamAppend?.(picked.path, started.link.journalId, me.device, started.events);
      setState((current) => ({
        ...current,
        projects: current.projects.map((item) => (item.id === projectId ? { ...item, team: started.link } : item)),
      }));
      stateRef.current = {
        ...stateRef.current,
        projects: stateRef.current.projects.map((item) => (item.id === projectId ? { ...item, team: started.link } : item)),
      };
      await syncProject(projectId);
      return { ok: true, message: "Shared. Send this locator to your teammate.", locator: started.locator };
    },
    [local, setState, snapshots, stateRef, syncProject],
  );

  const join = useCallback(
    async (locator: string): Promise<TeamResult> => {
      const me = local();
      if (!me) return { ok: false, message: "Open the desktop app to join a team." };
      const picked = await window.workhorse?.teamPickFolder?.();
      if (!picked) return { ok: false, message: "Pick this computer's copy of the shared team folder." };
      const joined = joinTeam({ locator, folder: picked.path, local: me, projects: stateRef.current.projects });
      if ("error" in joined) return { ok: false, message: joined.error };
      await window.workhorse?.teamAppend?.(picked.path, joined.project.team!.journalId, me.device, joined.events);
      const place = (projects: Project[]) =>
        projects.some((item) => item.id === joined.project.id)
          ? projects.map((item) => (item.id === joined.project.id ? joined.project : item))
          : [...projects, joined.project];
      setState((current) => ({ ...current, projects: place(current.projects), activeProjectId: joined.project.id, activeSessionId: null }));
      stateRef.current = { ...stateRef.current, projects: place(stateRef.current.projects) };
      await syncProject(joined.project.id);
      return { ok: true, message: `Joined ${joined.project.name}. Link your own folders on this computer.` };
    },
    [local, setState, stateRef, syncProject],
  );

  const handInbox = useCallback(
    async (projectId: string, to: string) => {
      const me = local();
      if (!me) return { ok: false, message: "Open the desktop app first." };
      return appendOne(projectId, inboxOwnerEvent({ view: viewOf(projectId), to, how: "handoff", local: me }), `${to} owns the inbox.`);
    },
    [appendOne, local],
  );

  const takeInbox = useCallback(
    async (projectId: string) => {
      const me = local();
      if (!me) return { ok: false, message: "Open the desktop app first." };
      return appendOne(projectId, inboxOwnerEvent({ view: viewOf(projectId), to: me.seat, how: "take", local: me }), "You own the inbox.");
    },
    [appendOne, local],
  );

  const setCeiling = useCallback(
    async (projectId: string, usd: number | null) => {
      const me = local();
      if (!me) return { ok: false, message: "Open the desktop app first." };
      const ceiling = usd && usd > 0 ? { usd } : null;
      return appendOne(projectId, ceilingEvent(viewOf(projectId), ceiling, me), ceiling ? "Shared ceiling set." : "Shared ceiling cleared.");
    },
    [appendOne, local],
  );

  const shareWorkshopGrant = useCallback(
    async (projectId: string, packId: string) => {
      const me = local();
      if (!me) return { ok: false, message: "Open the desktop app first." };
      const settings = stateRef.current.settings;
      const grant = workshopGrantFor(settings.workshop, settings.localCompute?.hosts ?? [], packId);
      if (!grant) return { ok: false, message: "That add-on has no host on this desk." };
      return appendOne(projectId, workshopGrantEvent(viewOf(projectId), grant, me), `Shared ${packId} through ${grant.host}.`);
    },
    [appendOne, local, stateRef],
  );

  const projectOf = (sessionId: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const project = session?.projectId ? stateRef.current.projects.find((item) => item.id === session.projectId) : undefined;
    return { session, project: project?.team ? project : undefined };
  };

  const sendStop = useCallback(
    (sessionId: string): string | null => {
      const { project } = projectOf(sessionId);
      const me = local();
      const hold = project ? held.current[project.id] : undefined;
      if (!project || !me || !hold) return null;
      const total = teamProjectTotal({
        view: hold.view,
        beats: hold.beats,
        now: Date.now(),
        device: me.device,
        seat: me.seat,
        projectId: project.id,
        localUsage: stateRef.current.usage,
      });
      return teamCeilingStop(total, hold.view.ceiling);
    },
    [local, stateRef],
  );

  const canStop = useCallback(
    (sessionId: string) => {
      const { session } = projectOf(sessionId);
      return !session || !deviceRef.current || canStopHere(session, deviceRef.current);
    },
    [stateRef],
  );

  const noteAnswer = useCallback(
    (request: PermissionRequest, answer: "once" | "session" | "deny") => {
      const { project } = projectOf(request.sessionId);
      const me = local();
      if (!project?.team || !me) return;
      const made = permissionAnsweredEvent(project.team.journalId, request, answer, me);
      if (made) void window.workhorse?.teamAppend?.(project.team.folder, project.team.journalId, me.device, [made]);
    },
    [local, stateRef],
  );

  const seat = seatOf(stateRef.current.settings.profile);
  return useMemo(
    () => ({ device, seat, snapshots, share, join, handInbox, takeInbox, setCeiling, shareWorkshopGrant, sendStop, canStop, noteAnswer }),
    [device, seat, snapshots, share, join, handInbox, takeInbox, setCeiling, shareWorkshopGrant, sendStop, canStop, noteAnswer],
  );
}
