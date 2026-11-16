import { createFileRoute } from "@tanstack/react-router";
import { TransferStatus } from "@/components/transfer-status";
export const Route = createFileRoute("/tx-preview")({ component: () => <div className="p-6"><TransferStatus profile="Vinay" phone="Pixel 8" /></div> });
