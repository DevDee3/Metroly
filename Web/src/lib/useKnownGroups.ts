"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "metroly.knownGroupIds";
const UPDATE_EVENT = "metroly-known-groups-updated";

/// There's no indexer wired up yet (Envio HyperIndex is the planned upgrade —
/// see README), so for now "which groups am I in" is tracked client-side per
/// browser. This means a group is only discoverable on a device that either
/// created it or was given its link. Good enough for a hackathon demo; the
/// first real infra upgrade should replace this with an onchain event index.
///
/// Uses useSyncExternalStore (rather than useState + useEffect) so reading
/// localStorage stays SSR-safe with no hydration mismatch, and so writes from
/// `remember` re-render every consumer of this hook immediately.
const EMPTY_SNAPSHOT: number[] = [];
let snapshot: number[] = EMPTY_SNAPSHOT;
let snapshotInitialized = false;

function readSnapshot(): number[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function getSnapshot(): number[] {
  if (!snapshotInitialized) {
    snapshot = readSnapshot();
    snapshotInitialized = true;
  }
  return snapshot;
}

function getServerSnapshot(): number[] {
  return EMPTY_SNAPSHOT;
}

function subscribe(callback: () => void) {
  const handleUpdate = () => {
    snapshot = readSnapshot();
    snapshotInitialized = true;
    callback();
  };

  window.addEventListener("storage", handleUpdate);
  window.addEventListener(UPDATE_EVENT, handleUpdate);
  return () => {
    window.removeEventListener("storage", handleUpdate);
    window.removeEventListener(UPDATE_EVENT, handleUpdate);
  };
}

export function useKnownGroups() {
  const groupIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const remember = useCallback((groupId: number) => {
    const current = getSnapshot();
    if (current.includes(groupId)) return;
    const next = [...current, groupId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // The native `storage` event only fires in *other* tabs, not this one,
    // so dispatch a matching custom event to update this tab's own state.
    window.dispatchEvent(new Event(UPDATE_EVENT));
  }, []);

  return { groupIds, remember };
}
