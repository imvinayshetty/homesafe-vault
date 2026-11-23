import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, History, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTransferBytes, transferLabels, type TransferRecord } from "@/lib/transfer-history";

const issueLabels = { missing: "File missing", size: "Size mismatch", checksum: "SHA-256 mismatch", unreadable: "File unreadable" };
export function TransferHistory({ backups, online, onVerify }: { backups: TransferRecord[] | null; online: boolean; onVerify: (id: string) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const busy = backups?.some(r => ["receiving_manifest", "transferring", "verifying"].includes(r.status)) ?? false;
  return <section aria-labelledby="transfer-history-heading" className="min-h-0 border-t border-border pt-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 id="transfer-history-heading" className="flex items-center gap-2 font-display text-xl"><History className="h-5 w-5 text-primary" />Transfer history</h3><span className="text-xs text-muted-foreground">{online ? "On this Vault · latest 100 backups" : "Disconnected · last received status"}</span></div>
    {backups === null ? <p className="py-4 text-sm text-muted-foreground">{online ? "Loading local transfer history…" : "Connect the local Vault to see backup history."}</p> : backups.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No transfers recorded for this phone yet.</p> : <div className="max-h-72 overflow-y-auto overscroll-contain pr-1" aria-label="Backup transfer records">
      {backups.map(r => {
        const bad = r.status === "failed" || r.status === "interrupted";
        const checking = r.status === "verifying";
        const open = expanded === r.id;
        return <article key={r.id} className="border-b border-border py-3 last:border-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><h4 className="break-words text-sm font-semibold">{r.name}</h4><p className="mt-1 text-xs text-muted-foreground">{new Date(r.startedAt).toLocaleString()} · {r.kind}</p></div>
            <span className={`flex shrink-0 items-center gap-1.5 text-xs ${bad ? "text-destructive" : r.status === "completed" ? "text-primary" : "text-muted-foreground"}`}>{bad ? <AlertTriangle className="h-4 w-4" /> : checking ? <Loader2 className="h-4 w-4 animate-spin" /> : r.status === "completed" ? <CheckCircle2 className="h-4 w-4" /> : null}{transferLabels[r.status]}</span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <div><p className="text-muted-foreground">File list</p><p className="mt-1 font-mono">{r.manifestReceived.toLocaleString()} / {r.totalFiles.toLocaleString()} entries</p><progress className="mt-1 h-1.5 w-full accent-primary" value={r.manifestReceived} max={r.totalFiles} aria-label={`${r.name} manifest progress`} /></div>
            <div><p className="text-muted-foreground">Received</p><p className="mt-1 font-mono">{formatTransferBytes(r.receivedBytes)} / {formatTransferBytes(r.totalBytes)}</p><p className="mt-1 text-muted-foreground">{r.receivedFiles.toLocaleString()} / {r.totalFiles.toLocaleString()} files</p></div>
            <div><p className="text-muted-foreground">Integrity</p><p className={`mt-1 ${r.integrity.status === "verified" ? "text-primary" : r.integrity.status === "mismatch" || r.integrity.status === "unreadable" ? "text-destructive" : "text-muted-foreground"}`}>{r.integrity.status === "verified" ? "SHA-256 + sizes verified" : r.integrity.status === "checking" ? `${r.integrity.checkedFiles.toLocaleString()} / ${r.totalFiles.toLocaleString()} checked` : r.integrity.status === "mismatch" ? `${r.integrity.mismatchCount} file mismatches` : r.integrity.status === "unreadable" ? "Verification unavailable" : "Not yet verified"}</p></div>
          </div>
          {r.failureReason && <p role="alert" className="mt-2 break-words text-xs text-destructive">{r.failureReason} <span className="font-mono">({r.failureCode})</span></p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {r.completedAt && <Button size="sm" variant="outline" disabled={!online || busy} onClick={() => onVerify(r.id)}><ShieldCheck className="h-4 w-4" />Recheck files</Button>}
            {r.integrity.issues.length > 0 && <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setExpanded(open ? null : r.id)}>{open ? <ChevronUp /> : <ChevronDown />}Mismatch details</Button>}
            {r.integrity.checkedAt && <span className="text-xs text-muted-foreground">Checked {new Date(r.integrity.checkedAt).toLocaleString()}</span>}
          </div>
          {open && <ul className="mt-2 space-y-2 text-xs" aria-label="Integrity mismatches">{r.integrity.issues.map((issue, i) => <li key={`${issue.path}-${i}`} className="border-l-2 border-destructive pl-3"><p className="break-all font-mono">{issue.path}</p><p className="mt-1 text-destructive">{issueLabels[issue.reason]} · expected {formatTransferBytes(issue.expectedBytes)}{issue.actualBytes !== undefined ? `, found ${formatTransferBytes(issue.actualBytes)}` : ""}</p></li>)}{r.integrity.mismatchCount > r.integrity.issues.length && <li className="text-muted-foreground">Showing the first {r.integrity.issues.length} of {r.integrity.mismatchCount} mismatches.</li>}</ul>}
        </article>;
      })}
    </div>}
  </section>;
}