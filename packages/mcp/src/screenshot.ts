import { FrameKind, SimViewClient } from "@simview/client";

/** PNG frames have no request ID, so each capture owns its transport. */
export async function captureScreenshot(
  primary: Pick<SimViewClient, "socketPath" | "token">,
  signal: AbortSignal,
  attach: typeof SimViewClient.attach = SimViewClient.attach,
) {
  const client = await attach(primary.socketPath, primary.token, "h264", {
    signal,
    timeoutMs: 2_000,
  });
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    signal.throwIfAborted();
    let received = false;
    let rejectBytes!: (error: unknown) => void;
    const bytesPromise = new Promise<Uint8Array>((resolve, reject) => {
      rejectBytes = reject;
      unsubscribe = client.on(FrameKind.PngScreenshot, (bytes) => {
        received = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(bytes);
      });
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    // A cancelled payload wait may reject before metadata; observe it immediately.
    void bytesPromise.catch(() => {});
    const metadata = await client.request("capture.screenshot", {}, { signal, timeoutMs: 20_000 });
    if (!received) {
      timer = setTimeout(
        () => rejectBytes(new Error("Timed out waiting for PNG screenshot payload")),
        5_000,
      );
    }
    const bytes = await bytesPromise;
    signal.throwIfAborted();
    return { ...metadata, bytes };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    signal.removeEventListener("abort", abort);
    await client.close();
  }
}
