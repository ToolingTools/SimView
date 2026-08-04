# SimView Android agent

This is a transient, clean-room `app_process` agent. It is pushed to a random
mode-0600 path under `/data/local/tmp`, authenticated before accepting commands,
and removed when its owning backend stops. It has no runtime dependencies.

Build with JDK 17, Android SDK platform 35, and build-tools 35.0.0:

From the repository root, run `bun run build:android-agent` (the `build.sh`
wrapper invokes the same authoritative build).

The output is `native/SimViewAndroid/build/simview-android-agent.jar`. The release
pipeline copies that file beside `simview-core` as `simview-android-agent.jar`.
The native host currently treats the agent as an optional acceleration path;
ADB screencap and shell input remain the compatibility fallback.
