# Google and Feishu sign-in

Codoxear supports configured Google and Feishu connections. Sign-in creates an account on that Hub; it does not grant Hub membership, access to Computers, or ownership. Access comes from an invitation or an explicit administrator grant. Returning sign-in uses the same provider identity, even when the user's email or display name changes. There is no automatic email-based account merging.

Add the desired entries from [`config/providers.example.json`](../config/providers.example.json) to the Hub's private configuration. Replace every placeholder with the application's real credentials. Set `CODOXEAR_HUB_CONFIG` to that JSON file before starting the Hub. The optional identity service uses `CODOXEAR_IDENTITY_CONFIG` for its own private configuration. Configure only connections you intend to offer. The browser obtains the available connections from the authentication API.

App secrets remain on the server. Do not put them in browser storage, frontend environment variables, source control, or the public frontend bundle. Preserve each connection ID and its associated provider application; changing an application's client ID requires a new connection ID because existing identity bindings belong to the original application.

## Google

1. In [Google Cloud Console](https://console.cloud.google.com/), configure the OAuth consent screen for your audience. If the app is in testing, add the people who will test it.
2. Create an OAuth client with application type **Web application**.
3. Register this exact **Authorized redirect URI**, replacing the origin with the public HTTPS origin of the Hub or optional identity service that performs the exchange:

   ```text
   https://YOUR-AUTH-ORIGIN/auth/google-main/callback
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
   https://YOUR-AUTH-ORIGIN/auth/feishu-main/callback
   ```

4. Put the App ID and App Secret in the private `feishu-main` configuration. A different connection ID changes the callback path.

Login-only user information needs no extra API scope. Codoxear does not request email, phone or `offline_access`; it does not need refresh tokens to create its own authenticated session. The application must still be enabled and available to the user.

Feishu uses S256 PKCE and its current v3 token endpoint, `https://accounts.feishu.cn/oauth/v3/token`, followed by authenticated `https://open.feishu.cn/open-apis/authen/v1/user_info`. Authorization codes expire after five minutes and can be exchanged only once. Accounts bind to the configured application connection, `tenant_key` and `open_id`. Feishu email and phone values are imported by administrators and are not verified ownership claims; Codoxear ignores them for sign-in and account linking.

Developer-created Feishu applications are Confidential Clients and require an App Secret even when PKCE is used. Public Client registration is not open to ordinary developers. A browser or native app cannot safely contain this secret, so token exchange runs on the configured Hub or optional identity service.

Sources: [Feishu authorization codes](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code), [current v3 token exchange](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3), [user information](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get), and [application availability](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability).

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
