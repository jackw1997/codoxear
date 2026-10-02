# AppGallery test distribution

Status at 23:50 on 2026-10-02: **Release package submitted to invitation testing; not yet available to install.** AGC accepted package legality. After selecting the owner's external test group, the final Save advanced the version to automated pre-review; a fresh list now reports waiting for review with self-test running. The invitation landing page says the test has not started. Privacy generation completed and the hosted policy is associated with the version. The current app UI exposes external invitation groups only. Huawei documents that apps not yet switched can request migration to AppTest through support. A concrete migration request is prepared and awaiting the owner's authorization to contact Huawei. A reachable reviewer/demo service has not been provided; the review notes disclose that limitation. Remote market updates remain the sole priority and are not yet accepted on the phone.

Invitation links, account identifiers and hosted policy records remain in the owner’s local operational notes.

## Candidate

- App: Codoxear; bundle: `com.codoxear.mobile`.
- Version: `0.1.0` / `10000`; uploaded to AGC at 20:33:23 local time.
- Product: `appgallery`; build mode: `release`.
- Existing `default` product retains the physical-device debug signing configuration.
- `build-profile.json5` is machine-local and ignored; start from `build-profile.example.json5` on new checkouts.
- The machine-local `appgallery` product has its own release signing configuration. Certificate and Profile: `Codoxear-release-20261002`; debug signing remains separate.
- APP ID: `6917617988747510500`. Package legality passed; HAP code signature and digest verified with the SDK signing tool.
- Frozen APP SHA-256: `a095320b2b86d51cb5b13746b9c30e2c9a711a0a2ffd04e6f6bc238cf410363d`.
- Frozen HAP SHA-256: `5ea1fa9064ea57180c7904d9c6f92274758ac67092d694bb47e438edc4ab32a4`.
- Keep the private keystore, certificate/Profile, encrypted signing material and password outside Git. Future updates must preserve this release identity.

Build from this directory's parent:

```sh
DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk \
JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home \
/Applications/DevEco-Studio.app/Contents/tools/node/bin/node \
/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js \
  --mode project -p product=appgallery -p buildMode=release assembleApp --no-daemon
```

## Account-dependent steps

1. Sign in to AGC using the account that owns the app. Inspect existing APP IDs before creating anything; preserve `com.codoxear.mobile` if already registered there.
2. On DevEco 6.1.1, obtain a release certificate from a CSR and a matching release Profile for this bundle. A release keystore and verified CSR have been prepared in the agent's private workspace outside Git. Keep the key and its password private; only the CSR is uploaded to request a certificate. Reuse an existing suitable signing identity if the app already has one.
3. Create a release Profile for the existing app and selected release certificate in “Certificates, APP IDs & Profiles.” If approved restricted ACL permissions are required, include them in that Profile; do not assume debug permissions carry over. Add a distinct release signing configuration to the local build profile and associate only `appgallery`; build and verify the signed `.app`.
4. Prefer **AppTest internal testing** if exposed for the account. Internal testers must be AGC users with access to the app; select only the intended owner. This is distinct from “designated device distribution (formerly internal testing),” whose current guide limits it to enterprise developers.
5. Upload the release package, prepare the test version, actual app description, privacy information and contact fields, and select the internal group. The current AppTest guide says internal-only groups use Save; external groups require review. Confirm actual account UI before predicting availability.
6. Accept the invitation and verify installation/update on the actual phone. Preserve local drafts; do not uninstall to force an update without resolving data preservation.
7. Repeat with increasing version/build numbers; verify each artifact before distribution. The AppTest validity rules still apply.

## Prepared test description

Codoxear is a native HarmonyOS companion for connecting to the user's Codoxear server and continuing Codex, Pi and Claude Code sessions. This development version includes session/chat controls, transcript search, Markdown/math, file and Git viewers, media tools and appearance settings. Full parity remains under verification; Huawei background notification delivery has not been accepted on the physical device.

Suggested test notes: Verify installation and future updates over mobile data, server login, send/reconnect behavior, file viewing and the three appearance themes in light/dark modes. Report failures with the operation and visible error.

The app/server privacy description must reflect the actual deployment. Do not invent the developer's legal identity, contact details, retention periods or public policy URL. App authentication, drafts, user-chosen uploads and optional notification registration must be represented accurately.

## Away-from-home use

Distribution only updates the client. `http://127.0.0.1:19744` is the development forwarding endpoint and does not work after leaving the debug connection. The owner must identify the intended remote server/VPN; then verify an authenticated connection from the phone with Wi-Fi and USB disconnected. No public endpoint has been created by this work.

## Primary references checked on 2026-10-02

- [Release packaging, including pre-26 DevEco signing](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-publish-app)
- [AppTest internal group and eligibility](https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-apptest-create-internalgroup-0000002486254204)
- [Create and publish an AppTest version](https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-apptest-release-testapp-0000002292711385)
- [Designated-device distribution limits](https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-internal-test-guide-0000002295325149)
- [Release certificate](https://developer.huawei.com/consumer/cn/doc/doccenter-getting-started/agc-help-release-cert-0000002283336729)
- [Release Profile and permission inclusion](https://developer.huawei.com/consumer/cn/doc/doccenter-getting-started/agc-help-release-profile-0000002248341090)

### Internal AppTest availability

Huawei's [test-group API documentation](https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-test-api-add-test-group-user-0000002236201338) (updated 2026-08-05) says internal groups are AppTest-specific. For apps not switched to AppTest invitation testing, contact support under 上架与运营 → 应用市场 → 应用测试 with developer name, developer ID, app name and APP ID. Verify the developer ID in the account UI; do not infer it from a URL parameter. No support request has been sent.

The [official open-test overview](https://developer.huawei.com/consumer/cn/agconnect/open-test/) describes internal tests of up to 100 people without manual review. Its general timing is not a guarantee for this account or this package. The authenticated application still exposes only external groups. The migration request has been prepared; no support ticket has been sent. The support page quotes 1–2 business days for a response, so it does not establish same-day availability.
