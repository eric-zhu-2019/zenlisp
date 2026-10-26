import type { AppEvent } from "./protocol/AppEvent";
import type { Request } from "./protocol/Request";
import type { Response } from "./protocol/Response";

export interface Backend {
  request(req: Request): Promise<Response>;
  onEvent(listener: (e: AppEvent) => void): void;
}

function tauriBackend(): Backend {
  return {
    async request(req) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Response>("rpc", { req });
    },
    onEvent(listener) {
      import("@tauri-apps/api/event").then(({ listen }) => listen<AppEvent>("app-event", (e) => listener(e.payload)));
    },
  };
}

function socketBackend(url: string): Backend {
  const listeners: ((e: AppEvent) => void)[] = [];
  const pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  let next = 1;
  const ready = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`cannot reach ${url}. Run: cargo run -p zenlisp-dev`));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event) listeners.forEach((l) => l(msg.event));
      else {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.err !== undefined) p?.reject(new Error(msg.err));
        else p?.resolve(msg.ok);
      }
    };
  });
  return {
    async request(req) {
      const ws = await ready;
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, req }));
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
  };
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const bridge = () => new URLSearchParams(location.search).get("bridge") ?? "ws://127.0.0.1:7878/ws";

/** Where a page of the local HyperSpec is served: the app's clhs: scheme, or the dev bridge. */
export function hyperspecUrl(page: string) {
  return inTauri ? `clhs://localhost/${page}` : `${bridge().replace(/^ws/, "http").replace(/\/ws$/, "")}/clhs/${page}`;
}

let instance: Backend | null = null;
const connect = () =>
  (instance ??= inTauri
    ? tauriBackend()
    : socketBackend(bridge()));

/** Connects on first use, so importing this module has no side effects. */
export const backend: Backend = {
  request: (req) => connect().request(req),
  onEvent: (listener) => connect().onEvent(listener),
};
