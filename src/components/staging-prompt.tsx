import { Button } from "@/components/ui/button";

export interface StagingNeed { needBytes: number; freeBytes: number }
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Shown when this computer's default folder cannot receive the backup first: the owner picks a HomeSafeTemp folder on a drive with room, on a drive with room. */
export function StagingPrompt({ need, onChoose }: { need: StagingNeed | null; onChoose?: (() => void) | undefined }) {
  if (!need) return null;
  return <div role="alert" className="mt-3 rounded-xl border border-warning/50 p-4 text-left text-sm">
    <p className="font-medium">Your phone chose the fast option: this computer needs more room to receive the backup first.</p>
    <p className="mt-1 text-muted-foreground">The default folder has {gb(need.freeBytes)} free; this backup needs {gb(need.needBytes)} (its size plus 2 GB). Create a folder named <strong>HomeSafeTemp</strong> on a drive with at least {gb(need.needBytes)} free and choose it. Your phone is waiting for this and will carry on by itself, or you can pick Direct to the drive on the phone instead.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {onChoose && <Button size="sm" onClick={onChoose}>Choose HomeSafeTemp folder…</Button>}
    </div>
  </div>;
}
