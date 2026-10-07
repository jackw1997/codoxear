# Fresh independent v2 deployment

This deployment creates two independent Hubs, a static client and two separately
enrolled Computers on the same Hub for delegation. Existing state stays archived separately. Only the preserved
public origins and LiteLLM launch settings carry forward. No demo processes,
scripted provider or old catalogs are used.

Generate a **new** private directory; the default fresh local owner is `owner@codoxear.local`:

```sh
node --import tsx deploy/fresh-v2/bootstrap.ts /absolute/private/fresh-state
```

The generator reads `~/.local/share/codoxear-v2/next/public-origins.json` and
`pi-litellm-launch.json`, creates random Hub IDs/OTP keys and a fresh owner password,
and saves credentials privately. It refuses an existing destination. An optional
second argument chooses another owner email; old accounts are not copied. A generation failure may leave
an incomplete new directory; inspect it privately and choose another empty path.

Build the reviewed full image using `runtime/oar/build-docker.sh <commit>
codoxear-v2-oar:local`. It includes the independent Hub, client and Computer
entrypoints, native CLIs, assets and real OAR dependencies. The OAR lock and image
must be available before starting. Deploy only with authorized Docker access:

```sh
export FRESH_STATE=/absolute/private/fresh-state
export CODOXEAR_V2_IMAGE=codoxear-v2-oar:local
docker compose -f deploy/fresh-v2/compose.yml --profile computer up -d
```

The image runs as UID 1000. Private directories must be owned by that deployment
user; do not make private files publicly readable. The loopback ports match the
existing TLS gateway: 19520 client, 19530/19531 Hubs, and 19500 guide (served by the
fresh static client). Retain the existing gateway and trusted TLS configuration;
the generated `Caddyfile.fragment` is an optional reviewed replacement fragment
with a guide redirect. Public client, guide and Hub origins are preserved. This
document does not authorize changing other gateway sites. A network-disabled
provisioning container creates each independent owner/catalog and two Computer
credentials through the domain commands before either Hub starts. Their new
databases and signing keys remain separate. Hubs receive no bootstrap password
environment. Computers receive only their own attachment and LiteLLM settings;
the owner credential is not mounted into them.

Provisioning writes a durable pending receipt before the first catalog mutation
and a complete receipt after all catalogs/attachments exist. A later invocation
validates the receipt, ownership, password and credential hashes and performs no
reset. Existing catalog/Computer state without a receipt, or an incomplete
receipt, fails closed and needs private operator inspection. Do not delete the
receipt or retry against partially initialized state. Provisioning exits before
the resident stack starts, so its 256 MiB ceiling does not add to resident usage.

Sign into the first fresh Hub from the preserved public client address using
`private/owner.json`. Computer A and Computer B are already admitted to that same
Hub under the owner, who has target creation authority on both. Each attachment
uses OAR, the explicitly reviewed locally trusted policy and one resident managed
runtime. OAR does not implement interactive native permission prompts. The second
Hub remains independently available. Public Hub HTTPS and the existing
LiteLLM endpoint must be reachable from the Computer. No proxy workaround is
installed. Computer-local `.pi/agent/models.json` and `settings.json` offer the
preserved LiteLLM model/provider by default; credentials stay off the Hubs. Pi
supplies its normal defaults for model limits absent from the preserved launch
settings; actual context/output capacity still needs provider verification.
The endpoint/key/model/effort are also retained exactly in the private launch file. This file is
mounted privately at `/private/pi-litellm-launch.json`, and the native terminal
CLI also accepts it with `run --backend pi --launch /private/pi-litellm-launch.json`.

The configured resident memory ceilings total 2688 MiB: two Hubs at 256 MiB,
client at 128 MiB and two Computers at 1024 MiB each, with swap disabled and
restart attempts bounded at two. These are starting
limits, not measured capacity. Keep build/verification serialized and separately
capped at 2 GiB. Measure whole-stack memory and exercise fresh login, enrollment,
real LiteLLM conversations and history before claiming deployment acceptance.
