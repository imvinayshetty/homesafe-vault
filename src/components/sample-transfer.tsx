import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { AwaitingCard, TransferScreen } from "@/components/transfer-status";
import type { TransferState } from "@/lib/vault-daemon";

/** Demonstration only: scripted stages, clearly labelled, never used for real transfers. */
const SCRIPT: TransferState[] = [
  { stage: 1 }, { stage: 2 }, { stage: 3 } as TransferState,
  ...[0.12, 0.3, 0.48, 0.66, 0.84, 1].map((progress): TransferState => ({ stage: 4, progress })),
  { stage: 5, progress: 1 },
];

export function SampleTransfer() {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0 || step >= SCRIPT.length - 1) return;
    const t = setTimeout(() => setStep(s => s + 1), step >= 3 && step < 8 ? 900 : 2200);
    return () => clearTimeout(t);
  }, [step]);
  const play = <button onClick={() => setStep(0)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90"><Play className="h-4 w-4" />Play sample transfer</button>;
  return <>
    <AwaitingCard service="offline" profile="Vinay" phone="Pixel 8" sample action={play} />
    {step >= 0 && <TransferScreen sample state={SCRIPT[step] ?? { stage: 0 }} profile="Vinay" phone="Pixel 8" service="offline" onClose={() => setStep(-1)} />}
  </>;
}
