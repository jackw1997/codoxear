# Codoxear for HarmonyOS

Native ArkUI/ArkTS client for the existing Codoxear HTTP API. The project is in
active development; **full feature and visual parity is not yet accepted**.
See [the verification matrix](docs/harmonyos-verification.md) for implemented
behavior, evidence and remaining work.

The client uses native text, images, lists, editors, PDFKit, AVPlayer, document
pickers and notifications. It does not embed ArkWeb. Markdown is tokenized by
Marked; mathematical expressions are converted to SVG paths by MathJax's pure
JavaScript adaptor and displayed by ArkUI.

## Build and run

On a fresh checkout, copy `build-profile.example.json5` to `build-profile.json5`.
The latter is ignored by Git because DevEco stores local signing credentials in it.

Open `frontend/harmonyos` (this directory) in DevEco Studio with the HarmonyOS SDK installed. The
current development build has been exercised on HarmonyOS 6.1.1/API 24 virtual
devices. Configure signing in DevEco for a physical phone; the development HAP
used for simulator testing is unsigned.

On the development Mac, from the repository root:

```sh
cd frontend/harmonyos
DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk \
JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home \
/Applications/DevEco-Studio.app/Contents/tools/node/bin/node \
/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js \
  --mode module -p module=entry@default -p product=default assembleHap --no-daemon
```

The output is `entry/build/default/outputs/default/entry-default-unsigned.hap`.
Install with DevEco or `hdc install -r <hap>`, then start `EntryAbility` in
`com.codoxear.mobile`. Enter the Codoxear server address and its password.
Authentication cookies remain in process memory; drafts and appearance settings
are saved in the app's private files directory.

For AGC test distribution, see [AppGallery preparation](docs/appgallery-distribution.md).

## Phone-only development updates

The optional `updater` feature module adds a “Codoxear 更新” launcher entry to
the same signed application. It is enabled only for the `default` product, not
AppGallery release builds. Build it with the command above, replacing
`module=entry@default` with `module=updater@default`.

The current phone was provisioned once over USB using normal HDC debugging:
`hdc -t <device> tmode port 38765`. The phone explicitly trusted the updater's
local HDC identity. The updater then connects to `127.0.0.1:38765`, so local
installation does not require a Wi-Fi network. Keep developer mode and USB
debugging enabled. TCP debugging binds beyond loopback and still requires the
OS's HDC authorization; no authentication bypass is used.

Download the signed HAP sent through Raft, then choose it with the updater's
system file picker and confirm installation. On the current phone Raft stores
downloads under “我的手机 → 兼容应用数据 → Download → Raft”. The updater copies
only the selected file into its sandbox and runs a fixed replacement-install
command. Installation may close the application; reopen the updater to inspect
the system-reported last installation time. Existing app data is retained.

Keep the original debug signing identity and versionCode 10000 for entry-only
updates while this matching feature module remains installed. Before changing
the application version, deliver and verify both matching modules together.
Do not uninstall the application or replace its signing identity to update it.
These debug packages are provisioned for the configured device; this is not a
general installer for arbitrary friends' phones.

Verified 2026-10-03: cellular Raft download with Wi-Fi disabled, on-phone HDC
replacement installation, unchanged original install time and saved server
address, retained entry/updater modules, reopening and reconnecting, and
switching between main and updater abilities. USB-disconnected operation and
persistence across a phone reboot are awaiting the owner's final check.
HTTPS URL download is available but was not part of this verified path.

The prebuilt arm64 native library derives from LMV475/hap-installer's HDC bridge
and OpenHarmony HDC 6.0, with OpenSSL 3.2.0, LZ4 1.9.4, bounds-checking and the
OHOS C++ runtime. Notices are shipped in `updater/src/main/resources/rawfile/`.
Local reproducible source/build work is retained in the agent workspace under
`research/hap-installer`, `research/openssl` and `research/hdc-build`; it must be
packaged into a portable dependency build before this is ready for public
source distribution. The bridge modifications serialize commands, reset
command parsing state, and prevent duplicate server threads.

## Verification

Follow the repository's Docker-only testing policy. Do not point verification
at a live deployment or use host sessions. The current disposable fixture is
published on loopback 19743; emulator forwarding uses `hdc rport tcp:19743
tcp:19743`. Port 19744 is reserved for a Docker fault proxy.

```sh
node tests/model_behavior.cjs
python3 tests/native_ui.py login
python3 tests/native_ui.py capture /absolute/path/capture.png
```

The model harness uses the TypeScript compiler bundled with DevEco. Override
`TYPESCRIPT_PATH` if the installation differs. `native_ui.py` drives real
`hdc uitest` controls; it does not inject application state. Set `CODOXEAR_HDC_TARGET` explicitly to an available disposable device.
Targets `127.0.0.1:5555`, `127.0.0.1:15556`, and `127.0.0.1:15557` currently
hold user previews (15557 is the browser-controlled preview) and must not be
used for development tests while reserved. Build the HAP and
verify the changed workflows on the native UI after model tests pass.

`fixture_backend.py` runs only in Docker with the throwaway `/home/tester`
home. It emits synthetic transcripts and acknowledges sends; it does not run
or validate an actual model. Separate `native_real_cli.py`, `native_launch_real.py`
and `native_delete_real.py` checks exercise actual Pi, Codex and Claude Code
installed inside the isolated container, including tmux creation, explicit resume
and deletion. `auth_proxy.py` injects 401/503 failures for native
recovery tests. `native_scroll.py` exercises an explicitly prepared native
fixture state documented in that script.

## Vendor assets

- Marked 15.0.12, MIT: `entry/src/main/ets/vendor/marked.LICENSE`.
  Regenerate its module wrapper with `python3 scripts/sync_marked.py`.
- MathJax 3.2.2, Apache-2.0: `entry/src/main/ets/vendor/mathjax.LICENSE`.
  Regenerate the browser-independent SVG bundle with `sh scripts/sync_math.sh`.
  Its npm dependency graph is locked in `tools/math/package-lock.json`.

- Highlight.js 11.11.1, BSD-3-Clause: `entry/src/main/ets/vendor/highlight.LICENSE`.
  Regenerate the native token emitter with `sh scripts/sync_highlight.sh`.
  Dependency versions are locked in `tools/highlight/package-lock.json`.
- CSS-tree 3.1.0, MIT: `entry/src/main/ets/vendor/css.LICENSE`.
  Regenerate the native CSS parser with `sh scripts/sync_css.sh`.

Generated JavaScript is included with its source entry and license so normal
HAP builds do not require downloading the bundler or math dependencies.
