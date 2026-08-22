import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};

export type PersistedEnvelope = {
    app: "infinite-canvas";
    version: 1;
    writtenAt: string;
    state: string;
};

export function createPersistedEnvelope(state: string, writtenAt = new Date().toISOString()): PersistedEnvelope {
    return { app: "infinite-canvas", version: 1, writtenAt, state };
}

export function parsePersistedEnvelope(value: string | null): string | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<PersistedEnvelope>;
        if (parsed.app !== "infinite-canvas" || parsed.version !== 1 || typeof parsed.state !== "string") return null;
        JSON.parse(parsed.state);
        return parsed.state;
    } catch {
        return null;
    }
}
