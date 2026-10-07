# Google and Feishu sign-in

Codoxear supports configured Google and Feishu connections. The web client selects a Hub, discovers its configured providers, signs in through that Hub, and enrolls a client-held signing key. Each Hub represents one organization. Sign-in creates a local account; it does not grant Hub membership, access to Computers, or ownership. Access comes from an invitation or an explicit administrator grant. Returning sign-in uses the same provider identity, even when the user's email or display name changes. There is no automatic email-based account merging.

Add the desired entries from [`config/providers.example.json`](../config/providers.example.json) to each Hub's private `providers` array. Replace placeholders with that Hub's actual app credentials and configure `CODOXEAR_HUB_CONFIG`. One Hub permits at most one Feishu app and one verified organization tenant. Google can be offered separately under the Hub's own access policy. The browser discovers providers from the Hub API. No global login service or broker configuration is required.

App secrets remain on the server. Do not put them in browser storage, frontend environment variables, source control, or the public frontend bundle. Preserve each connection ID and its associated provider application; changing an application's client ID requires a new connection ID because existing identity bindings belong to the original application.

## Google

1. In [Google Cloud Console](https://console.cloud.google.com/), configure the OAuth consent screen for your audience. If the app is in testing, add the people who will test it.
2. Create an OAuth client with application type **Web application**.
3. Register this exact **Authorized redirect URI**, replacing the origin with the public HTTPS origin of the Hub that performs the exchange:

   ```text
   https://YOUR-HUB-ORIGIN/auth/google-main/callback
   ```

4. Copy its client ID and client secret into the private `google-main` connection configuration. A different connection ID changes the callback path to `/auth/CONNECTION-ID/callback`.

The browser frontend's `/auth-callback` route is a separate Codoxear client callback. It is not the Google provider callback. Preserve ports and any configured origin prefix in the provider URI; the registered URI must match the application's redirect URI.

Google requests `openid profile email`. The adapter discovers OAuth and signing-key endpoints from Google's official OIDC discovery document, sends state, a nonce and S256 PKCE, and validates the ID token's signature, callback issuer, ID token issuer, audience, expiry and nonce. The Google `sub` claim is the account identity. A verified email may be displayed as contact information; it is not an identity key and does not link an existing account.

Sources: [Google OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect) and [API reference](https://developers.google.com/identity/openid-connect/reference).

## Feishu

1. Create and enable a custom or store application in [Feishu Open Platform](https://open.feishu.cn/app). Ensure the intended users have permission to use it; publish/install it and set the availability audience as required by your tenant.
2. In **Credentials & Basic Information**, obtain the App ID and App Secret.
3. In **Security Settings**, register this exact redirect URL:

   ```text
   https://YOUR-HUB-ORIGIN/auth/feishu-main/callback
   ```

4. Put the App ID and App Secret in the private `feishu-main` configuration. A different connection ID changes the callback path.

Login-only user information needs no extra API scope. Codoxear does not request email, phone or `offline_access`; it does not need refresh tokens to create its own authenticated session. The application must still be enabled and available to the user.

Feishu uses S256 PKCE and its current v3 token endpoint, `https://accounts.feishu.cn/oauth/v3/token`, followed by authenticated `https://open.feishu.cn/open-apis/authen/v1/user_info`. Authorization codes expire after five minutes and can be exchanged only once. Accounts bind to the configured application connection, `tenant_key` and `open_id`. Feishu email and phone values are imported by administrators and are not verified ownership claims; Codoxear ignores them for sign-in and account linking.

The token exchange sends JSON. A successful OAuth v3 response may omit `code`; Codoxear requires a nonempty `access_token` and rejects explicit errors or nonzero codes. User-info still requires its successful response envelope and a verified tenant/subject. See [Larksuite's v3 response regression](https://github.com/larksuite/cli/blob/main/internal/auth/uat_client_refresh_test.go). Failed exchanges log only their stage, a fixed failure category, HTTP status and numeric provider code when available; authorization codes, tokens, provider messages and app secrets are never logged. Start a new sign-in after a failed callback rather than refreshing a consumed authorization code.

Developer-created Feishu applications are Confidential Clients and require an App Secret even when PKCE is used. Public Client registration is not open to ordinary developers. A browser or native app cannot safely contain this secret, so token exchange runs on the owning Hub.

Sources: [Feishu authorization codes](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code), [current v3 token exchange](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3), [user information](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get), and [application availability](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability).

## One organization per Hub

Each organization administrator deploys a Hub and configures that organization's Feishu application on it. End users select the Hub and sign in through its advertised providers. They never supply an App Secret. A second organization uses a second Hub and its own app rather than adding organization connections to a global login service.

Connection IDs are unique and stable within a Hub. Use a new connection ID for a different OAuth app; changing its display name does not change its identity. Set the Feishu connection’s singular `tenant` to the expected organization tenant key. If omitted, only a fresh Feishu sign-in with the private initial-owner setup code can bind the Hub’s tenant. While an enabled Feishu connection remains unbound, Google cannot initialize ownership. Once bound, other tenants’ provider sessions and device keys are rejected. The persisted tenant cannot be changed through another user’s sign-in. Never derive organization membership from a display name, email domain or client-supplied tenant.

Accounts bind to the Hub-local connection, provider method, verified tenant and stable subject. Equal names/emails or provider IDs across Hubs do not merge accounts. Invites and Computer grants stay on the corresponding Hub. Authentication alone grants no Hub membership or Computer execution rights.

## Multiple accounts on one Hub

All independently authenticated accounts saved for the same Hub contribute access simultaneously. The client shows their combined accessible Computers and agents without duplicates. For each action it chooses one currently authorized identity that grants the required capability, then dispatches the action once. It never merges accounts or combines partial proofs into a new principal. Removing one saved identity leaves other identities and keys available; cached content must still be authorized by a remaining identity.

The Hub owner controls allowed sign-in methods in Hub settings: Feishu only, Google only, or both. Choices come from configured provider types so future providers can extend the list. The policy applies to existing sessions, public-key reconnects, refresh tokens and new OAuth sign-ins. A blocked provider's local key remains saved and works again when the policy permits it. Before removing the owner's current sign-in method, the owner must use another authorized owner identity that the new policy retains. Explicit identity linking can associate another provider proof with that owner account; equal email addresses never do so automatically.

A fresh provider sign-in enrolls a local nonextractable P-256 key. The Hub stores its public key and verifies signed, single-use challenges for reconnection. Provider app secrets remain on the Hub; private device keys remain on the client. Signing in with another Google or Feishu account creates a separate saved account. Explicit identity linking is a different operation and never happens merely because email addresses match.

## Initial owner

A new independent Hub requires a private random `setupToken` of at least 32
characters in its configuration. Generate one with `openssl rand -hex 32`; the
fresh deployment generator instead creates separate codes for each Hub in
`private/setup.json`.

The initial owner is a reserved disabled account. Sign in with Google or Feishu,
then submit the private setup code within five minutes of that verified sign-in.
Successful setup assigns the Hub and any Computers explicitly preprovisioned
for its pending owner to your account. Persisted ownership consumes the setup
operation: the code cannot claim it again. The first public sign-in alone does
not become owner. An ordinary new account still requires invitations or explicit
grants for Hub membership and Computer access.

## Verification limits

Adapter verification uses controlled HTTP transports and signed test tokens inside Docker. This exercises protocol and cryptographic rejection behavior without fabricated live connections. A successful real-provider sign-in requires your enabled provider application, actual credentials, registered public callback, and a permitted test user. Record that browser acceptance separately from isolated adapter tests.
