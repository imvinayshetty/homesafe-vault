import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const issueSchema = z.object({ path: z.string().min(1).max(1024), reason: z.enum(["missing", "size", "checksum", "unreadable"]), expectedBytes: count, actualBytes: count.optional() });
export const transferRecordSchema = z.object({
  id: z.string().min(1).max(128), profile: z.string().min(1).max(80), phone: z.string().min(1).max(80), name: z.string().min(1).max(80), kind: z.enum(["Full", "Custom"]),
  startedAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(),
  status: z.enum(["receiving_manifest", "transferring", "verifying", "completed", "failed", "interrupted"]),
  manifestReceived: count, totalFiles: count.positive().max(500000), receivedFiles: count, receivedBytes: count, totalBytes: count,
  failureCode: z.string().max(80).optional(), failureReason: z.string().max(300).optional(),
  integrity: z.object({ status: z.enum(["pending", "checking", "verified", "mismatch", "unreadable"]), checkedFiles: count, mismatchCount: count, issues: z.array(issueSchema).max(50), checkedAt: z.string().optional() }),
}).refine(r => r.manifestReceived <= r.totalFiles && r.receivedFiles <= r.totalFiles && r.receivedBytes <= r.totalBytes && r.integrity.checkedFiles <= r.totalFiles);
export type TransferRecord = z.infer<typeof transferRecordSchema>;
const snapshot = z.object({ type: z.literal("transfer_history"), backups: z.array(transferRecordSchema).max(100) });
export function parseTransferHistory(raw: unknown): TransferRecord[] | null {
  try { const result = snapshot.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw); return result.success ? result.data.backups : null; } catch { return null; }
}
export const transferLabels: Record<TransferRecord["status"], string> = { receiving_manifest: "Receiving file list", transferring: "Transferring", verifying: "Checking integrity", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };
export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}