import { Button } from "@/components/ui/button";

export interface StagingNeed { needBytes: number; freeBytes: number }
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Shown when this computer's default folder cannot receive the backup first: the owner picks a HomeSafeTemp folder on a drive with room, or saves straight to the backup drive. */
export function StagingPrompt({ need, onChoose, onDirect }: { need: StagingNeed | null; onChoose?: (() => void) | undefined; onDirect: () => void }) {
  if (!need) return null;
  return <div role="alert" className="mt-3 rounded-xl border border-warning/50 p-4 text-left text-sm">
    <p className="font-medium">Your phone is waiting: this computer needs more room to receive the backup first.</p>
    <p className="mt-1 text-muted-foreground">The default folder has {gb(need.freeBytes)} free; this backup needs {gb(need.needBytes)} (its size plus 2 GB). Create a folder named <strong>HomeSafeTemp</strong> on a drive with at least {gb(need.needBytes)} free and choose it. Then try the backup again on your phone.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {onChoose && <Button size="sm" onClick={onChoose}>Choose HomeSafeTemp folder…</Button>}
      <Button size="sm" variant="outline" onClick={onDirect}>Save straight to the backup drive instead</Button>
    </div>
  </div>;
}
