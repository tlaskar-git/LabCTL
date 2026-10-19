import { useState, useEffect } from 'preact/hooks';

// Shared app state that non-component modules (palette, job drawer, pages) can read.
const state = { user: null, hosts: [] };
const listeners = new Set();

export const getState = () => state;

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(fn => fn(state));
}

export function useAppState() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump(n => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return state;
}
