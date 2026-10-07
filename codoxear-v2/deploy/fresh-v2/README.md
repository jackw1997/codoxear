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
docker compose -f deploy/fresh-v2/compose.yml up -d hub-0 hub-1 client
```

The image runs as UID 1000. Private directories must be owned by that deployment
user; do not make private files publicly readable. The loopback ports match the
existing TLS gateway: 19520 client, 19530/19531 Hubs, and 19500 guide (served by the
fresh static client). Retain the existing gateway and trusted TLS configuration;
the generated `Caddyfile.fragment` is an optional reviewed replacement fragment
with a guide redirect. Public client, guide and Hub origins are preserved. This
document does not authorize changing other gateway sites. The independent Hubs
each bootstrap their own owner from `owner.env`; their databases and signing keys
are new and remain separate. Remove bootstrap environment from ongoing Hub
service configuration after successful first startup.

Sign into the fresh Hub from the preserved public client address using
`private/owner.json`. Create a Computer in that Hub; the interface returns an
eight-character attach code. Enroll through the native CLI using the chosen
public Hub origin and that code (prompted so it stays out of shell history):

```sh
docker compose -f deploy/fresh-v2/compose.yml run --rm computer-a \
  node dist/server/computer/main.js attach --workspace /home/node/workspace \
  --runtime oar --oar-permission-policy locally-trusted --oar-max-resident 1
```

The locally trusted policy is explicit because OAR does not implement interactive
native permission prompts. Review that policy before enrollment. A Computer has
one active Hub. Before starting, repeat enrollment using `computer-b` and a
separate Computer/code created in the **same** Hub. Each uses its own state and
one resident managed runtime; grant the initiating principal target creation
authority before exercising delegation. The second Hub remains independently
available. Public Hub HTTPS and the existing
LiteLLM endpoint must be reachable from the Computer. No proxy workaround is
installed. Computer-local `.pi/agent/models.json` and `settings.json` offer the
preserved LiteLLM model/provider by default; credentials stay off the Hubs. Pi
supplies its normal defaults for model limits absent from the preserved launch
settings; actual context/output capacity still needs provider verification.
The endpoint/key/model/effort are also retained exactly in the private launch file. This file is
mounted privately at `/private/pi-litellm-launch.json`, and the native terminal
CLI also accepts it with `run --backend pi --launch /private/pi-litellm-launch.json`.

After both enrollments, start both Computers:

```sh
docker compose -f deploy/fresh-v2/compose.yml --profile computer up -d computer-a computer-b
```

The configured resident memory ceilings total 2688 MiB: two Hubs at 256 MiB,
client at 128 MiB and two Computers at 1024 MiB each, with swap disabled and
restart attempts bounded at two. These are starting
limits, not measured capacity. Keep build/verification serialized and separately
capped at 2 GiB. Measure whole-stack memory and exercise fresh login, enrollment,
real LiteLLM conversations and history before claiming deployment acceptance.
