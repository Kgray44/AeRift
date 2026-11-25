import type { Transfer } from "@aerift/app-contract";
import { useEffect, useState } from "react";
import { ReceivedActivity } from "../ReceivedActivity";
import { mobileReceivedRows } from "./mobile-received-activity";
import type { MobileOperations, ReceivedCopy } from "./mobile-platform";

export function MobileReceivedActivity({ transfers, operations, receivedTip }: {
  transfers: readonly Transfer[];
  operations: Pick<MobileOperations, "listReceived" | "presentReceived">;
  receivedTip: string;
}) {
  const [catalog, setCatalog] = useState<readonly ReceivedCopy[]>();
  const [loading, setLoading] = useState(!!operations.listReceived);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const latestArrival = JSON.stringify(transfers.filter(item => item.direction === "incoming" && item.state === "completed").map(item => item.id).sort());
  useEffect(() => {
    if (!operations.listReceived) return;
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void operations.listReceived().then(result => {
      if (disposed) return;
      if (result.ok && Array.isArray(result.value)) setCatalog(result.value);
      else setError("Could not refresh files on this device.");
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoading(false);
      setError("Could not refresh files on this device.");
    });
    return () => { disposed = true; };
  }, [latestArrival, operations, refresh]);

  const open = catalog && operations.presentReceived
    ? async (item: {id: string}) => (await operations.presentReceived?.(item.id, "preview"))?.ok === true
    : undefined;
  return <ReceivedActivity rows={mobileReceivedRows(transfers, catalog)} loading={loading} error={error}
    onOpen={open} onRefresh={operations.listReceived ? () => setRefresh(value => value + 1) : undefined}>
    <p>{receivedTip}</p>
  </ReceivedActivity>;
}
