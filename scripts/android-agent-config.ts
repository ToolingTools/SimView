import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ANDROID_AGENT_PROTOCOL_VERSION = 2;

export async function validateAndroidAgentProtocol(root: string): Promise<void> {
  const mirrors = [
    {
      path: join(root, "native/SimViewAndroid/src/dev/simview/agent/Main.java"),
      expected: `PROTOCOL_VERSION = ${ANDROID_AGENT_PROTOCOL_VERSION};`,
    },
    {
      path: join(
        root,
        "native/SimViewCore/Sources/SimViewCore/Android/AndroidAgentLifecycle.swift",
      ),
      expected: `protocolVersion = ${ANDROID_AGENT_PROTOCOL_VERSION}`,
    },
  ];
  for (const mirror of mirrors) {
    if (!(await readFile(mirror.path, "utf8")).includes(mirror.expected)) {
      throw new Error(
        `${mirror.path} does not mirror Android agent protocol ${ANDROID_AGENT_PROTOCOL_VERSION}`,
      );
    }
  }
}
