# Computer managed runtime

Experimental implementation; not yet release-verified. Requires Node.js 24 and
`@botiverse/oar` exactly 0.13.3. The structural contract was inspected at upstream
commit `07a9c946aabf17e65bf6126f48dd42a4f21cb964`.

Install this directory's dependencies on the Computer only. The initial package
download is blocked in the implementation environment; a resolved lockfile and
native Docker acceptance are release gates. Do not describe this manifest as a
verified reproducible installation. Hub and Client retain their smaller independent
dependency trees.

Enable with `--runtime oar --oar-permission-policy locally-trusted` only after
reviewing that policy: the pinned OAR disables interactive approvals. Unsupported
policies fail before session launch. Worker processes have a 384 MiB JS heap limit,
which is not a total RSS or native subprocess limit. The controller defaults to
two resident workers and 60-second idle retirement; production memory still needs
process-tree measurements and an OS resource envelope before deployment.

Provider launch configuration stays in private Computer profile directories.
Pi receives an isolated model directory; Codex uses a private provider config;
Claude uses its provider environment. Native provider and resume behavior still
require integration verification. Interrupted/uncertain delivery is not silently
replayed. Terminal broker sessions remain discoverable through the native adapter.
