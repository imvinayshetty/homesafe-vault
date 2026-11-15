import { HardDrive, TrendingUp, AlertTriangle, CircleHelp } from "lucide-react";
import { backupSizeSummary, formatStorageBytes } from "@/lib/storage-health";
import { type Catalog, type StorageIssue } from "@/lib/backup-catalog";

interface StorageHealthProps { catalog: Catalog; connected: boolean; problem: StorageIssue | null }

export function StorageHealth({ catalog, connected, problem }: StorageHealthProps) {
  const readable = connected && (!problem || problem === "space");
  const summary = backupSizeSummary(readable ? catalog.entries : []);
  const recent = summary.days.slice(-14);
  const maximum = Math.max(1, ...recent.map(day => day.bytes));
  const chartHeight = 128;

  return (
    <section aria-labelledby="storage-health-heading" className="space-y-5 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="storage-health-heading" className="flex items-center gap-2 font-display text-xl"><HardDrive className="h-5 w-5 text-primary" />Storage health</h3>
        <span className="text-xs text-muted-foreground">{readable ? "Selected storage · all profiles" : connected ? "Storage access unavailable" : "No storage selected"}</span>
      </div>
      <dl className="grid gap-5 sm:grid-cols-3">
        <div><dt className="text-sm text-muted-foreground">Available drive space</dt><dd className="mt-2 text-xl font-medium">Unavailable</dd><dd className="mt-1 text-xs text-muted-foreground">Local drive measurement not connected</dd></div>
        <div><dt className="text-sm text-muted-foreground">Recorded backup size</dt><dd className="mt-2 font-mono text-xl text-primary">{readable ? formatStorageBytes(summary.bytes) : "—"}</dd><dd className="mt-1 text-xs text-muted-foreground">{readable ? `${summary.count} completed backups · not total drive usage` : "Connect storage to read backup records"}</dd></div>
        <div><dt className="text-sm text-muted-foreground">Capacity alerts</dt><dd className={`mt-2 flex items-center gap-2 text-sm font-medium ${problem === "space" ? "text-warning" : "text-muted-foreground"}`}>{problem === "space" ? <><AlertTriangle className="h-4 w-4" />Write limit reached</> : <><CircleHelp className="h-4 w-4" />Early warning unavailable</>}</dd><dd className="mt-2 text-xs text-muted-foreground">Free space and nearing-capacity alerts need the local Vault service. Check the drive’s free space on your computer.</dd></div>
      </dl>
      {problem === "space" && <p role="alert" className="border-l-2 border-warning pl-3 text-sm text-warning">The last write hit a storage limit. The drive may be full, or the browser may have reached its write limit. Free space and retry; a successful scan does not confirm free space.</p>}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="flex items-center gap-2 text-sm font-medium"><TrendingUp className="h-4 w-4 text-primary" />Backup size trends</h4><span className="text-xs text-muted-foreground">Daily saved size · latest 14 backup dates</span></div>
        {recent.length > 0 ? <>
          <div className="flex gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-2"><span className="h-2 w-2 bg-primary" />Full</span><span className="flex items-center gap-2"><span className="h-2 w-2 bg-chart-2" />Custom</span></div>
          <svg viewBox="0 0 560 160" className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Daily backup sizes. Exact dates and sizes are listed below.">
            <line x1="0" y1={chartHeight} x2="560" y2={chartHeight} className="stroke-border" />
            {recent.map((day, i) => {
              const slot = 560 / recent.length;
              const full = day.full / maximum * 112;
              const custom = day.custom / maximum * 112;
              return <g key={day.date}><title>{`${day.date}: ${formatStorageBytes(day.bytes)}`}</title><rect x={i * slot + slot * 0.2} y={chartHeight - full} width={slot * 0.6} height={full} className="fill-primary" /><rect x={i * slot + slot * 0.2} y={chartHeight - full - custom} width={slot * 0.6} height={custom} className="fill-chart-2" /></g>;
            })}
          </svg>
          <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Daily sizes</summary><ul className="mt-2 divide-y divide-border">{recent.map(day => <li key={day.date} className="flex flex-wrap justify-between gap-2 py-2"><time dateTime={day.date}>{day.date}</time><span className="font-mono text-xs">{formatStorageBytes(day.bytes)} · {day.count} backups</span></li>)}</ul></details>
        </> : <p className="py-6 text-center text-sm text-muted-foreground">{readable ? "No completed backup records yet." : "Connect storage to view backup size trends."}</p>}
        {(summary.incomplete > 0 || catalog.warnings.length > 0) && <p className="text-xs text-warning">Totals exclude incomplete backups and unreadable records. They may not represent every backup on the drive.</p>}
      </div>
    </section>
  );
}