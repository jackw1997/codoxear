# Codoxear computer

This is an independently installable source package. It contains only this component's entry points and the source closure of its declared shared libraries. No frontend, peer backend or local configuration is included.

Requires Node.js 24 or newer. From this extracted directory:

```sh
npm ci
npm run build
npm start
```

The Computer installs its separately pinned OAR runtime during `npm ci`. Run `npm run doctor` to inspect local runtime requirements without starting sessions. Installed Codex, Pi and Claude CLIs, provider credentials, workspace permissions and the explicit locally trusted managed-session policy remain local Computer configuration.

Build its own container with `docker build -t codoxear-computer .`. Mount private configuration, persistent data and any explicitly requested assets at runtime. Container configuration is external to the source archive.

The Computer image includes Pi `1.0.0`, Codex `0.160.0`, Claude Code `2.1.287`, Git, ripgrep, fd and FFmpeg. CLI versions match the native runtime image; vendor CLI transitive dependencies are not part of the Computer or OAR lockfiles. Native PTYs use the pinned `@lydell/node-pty` prebuilt Linux x64/arm64 packages, with optional dependencies enabled. The image build does not install Python or a compiler toolchain. Override `NODE24_IMAGE` with an approved Node 24 bookworm image digest when building a release.
