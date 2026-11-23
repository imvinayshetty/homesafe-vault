import { DAEMON_URL } from "@/lib/vault-daemon";

export interface LibraryBackup { name: string; kind: "Full" | "Custom"; date: string; complete: boolean; files: number; bytes: number }
export interface LibraryPhone { phone: string; revoked: boolean; backups: LibraryBackup[] }
export interface Library { profile: string | null; yourProfiles: string[]; otherProfiles: string[]; owned: boolean; phones: LibraryPhone[] }

type Raw = { type?: unknown; profile?: unknown; yourProfiles?: unknown; otherProfiles?: unknown; owned?: unknown; phones?: unknown; phone?: unknown; revoked?: unknown; backups?: unknown; name?: unknown; kind?: unknown; date?: unknown; complete?: unknown; files?: unknown; bytes?: unknown };
const names = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]).slice(0, 500) : null);
export function parseLibrary(raw: unknown): Library | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Raw;
  const yours = names(v.yourProfiles), others = names(v.otherProfiles);
  if (v.type !== "library" || !yours || !others || !Array.isArray(v.phones)) return null;
  const phones: LibraryPhone[] = [];
  for (const p of v.phones.slice(0, 200)) {
    const row = p as Raw;
    if (typeof row?.phone !== "string" || !Array.isArray(row.backups)) return null;
    const backups = row.backups.flatMap((b: unknown) => {
      const x = b as Raw;
      return typeof x?.name === "string" && (x.kind === "Full" || x.kind === "Custom") && typeof x.date === "string" && typeof x.complete === "boolean" && Number.isFinite(x.files) && Number.isFinite(x.bytes)
        ? [{ name: x.name, kind: x.kind, date: x.date, complete: x.complete, files: Number(x.files), bytes: Number(x.bytes) } as LibraryBackup] : [];
    });
    phones.push({ phone: row.phone, revoked: row.revoked === true, backups });
  }
  return { profile: typeof v.profile === "string" ? v.profile : null, yourProfiles: yours, otherProfiles: others, owned: v.owned === true, phones };
}

/** One-shot read of what this account may see on the Vault drive. Resolves null if the service is not reachable. */
export function fetchLibrary(accessKey: string, email: string, profile?: string): Promise<Library | null> {
  return new Promise(resolve => {
    let ws: WebSocket;
    const done = (value: Library | null) => { clearTimeout(timer); try { ws.close(); } catch { /* already closed */ } resolve(value); };
    const timer = setTimeout(() => done(null), 6000);
    try { ws = new WebSocket(DAEMON_URL); } catch { clearTimeout(timer); resolve(null); return; }
    ws.onopen = () => ws.send(JSON.stringify({ type: "authenticate", token: accessKey }));
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
    ws.onmessage = m => {
      try {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "service_ready") ws.send(JSON.stringify({ type: "list_library", email, ...(profile ? { profile } : {}) }));
        else if (msg.type === "library") done(parseLibrary(msg));
      } catch { done(null); }
    };
  });
}
