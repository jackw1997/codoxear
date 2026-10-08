# Native HarmonyOS client

This directory contains the v2-owned HarmonyOS application. `entry/src/main/ets/entryability/EntryAbility.ets` opens the native account/conversation screen, receives OAuth callbacks and Push Kit taps, and handles foreground/background teardown. It uses the presentation models already owned by v2; it does not import or copy the original application during build.

Open this directory as a Stage-model project in DevEco Studio with HarmonyOS SDK API 12 or a compatible newer SDK, ArkTS, Hvigor and the declared HarmonyOS plugin available. The build profile targets `5.0.0(12)`. Install project dependencies with the SDK's package tooling, configure a local signing profile, and build the `entry` module's `default` target. The repository does not contain signing credentials, an SDK installation or a generated Hvigor launcher. A signed device installation and configured Push Kit application are required for device acceptance.

Each independent Hub must register this public native client in its private `CODOXEAR_HUB_CONFIG`:

```json
{
  "clients": [
    {
      "id": "codoxear-harmony",
      "redirectUris": ["codoxear-v2://oauth/callback"]
    }
  ]
}
```

Keep the remaining Hub configuration and provider credentials external. Native account origins require exact HTTPS origins. System-browser login uses PKCE, a ten-minute transaction stored in the encrypted OS vault, an exact callback scheme/host/path, the returned Hub issuer and state, and one-use authorization codes. The screen supports cancelling sign-in, selecting saved accounts and Computers, removing accounts, and the existing direct server/password profile. There is no required global identity service.

Asset Store holds separate refresh credentials for each Hub/account and a persistent installation ID. Plain asset aliases contain only hashes. Assets require an unlocked device; access tokens remain in memory. Concurrent calls serialize refresh for each account. Before transmitting a rotating refresh token, the vault records an empty-token tombstone, so a process crash or lost response cannot replay the previous credential. A failed rotation requires sign-in again. Backgrounding clears selected presentation and in-memory access credentials. Startup while locked presents an unlock/retry screen.

`HubPush` keeps a registration collection keyed by Hub account and Computer, including the binding approved when notifications were enabled. One installation token can serve several Hubs. Token updates upload to every enabled registration; removing one account removes its Hub registration and refresh credential while preserving other accounts. The OS token is deleted when the final registration is removed. Offline server cleanup reports a retry requirement; a removed local account cannot open an old notification. Taps recheck current Computer binding and agent access before navigating. Configure the Hub's external Harmony service account for real background delivery.

Docker verification in `tests/native-harmony-accounts.test.ts` executes the delivered ArkTS account, Asset Store, NetworkKit and Push Kit adapter code with mocked OS APIs against two actual independent Hub OAuth and subscription APIs. It covers callback cancellation/restart, account separation, locked-vault reads and failed mutations, serialized and lost-response refresh, native transport refresh and account-switch fencing, multi-Hub token updates, current tap authorization, scoped logout, binding loss and the presenter's background lock lifecycle. An import-graph check verifies that local dependencies resolve inside this project. The combined workspace/native/shared-client suite passed 52 tests with no skips. `scripts/verify-delegated-workspaces-docker.sh` runs this suite in an isolated container.

These checks do not establish ArkTS SDK compilation, native screen rendering, signing/provisioning, physical device lock behavior, background delivery or real notification taps. Those require the configured SDK and device. The OS adapter follows Huawei's [system-browser linking API](https://developer.huawei.com/consumer/en/doc/harmonyos-references-V14/js-apis-inner-application-uiabilitycontext-V14) and [Asset Store guidance](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/asset-scenario1-V14); SDK behavior remains part of device acceptance.
