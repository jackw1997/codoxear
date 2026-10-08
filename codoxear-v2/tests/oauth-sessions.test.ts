import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { createIdentityApp } from "../src/auth/app.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");

test("ordinary Hub OAuth sessions refresh without device keys, retain proof age and revoke only the selected installation", async () => {
  const origin = "https://oauth-session.test", store = new Store(":memory:");
  const hub = store.change(state => initializeHub(state, "oauth-hub", "OAuth Hub"));
  const accounts = new Accounts(store, "ordinary-session-fixture-".repeat(3), { async send() {} });
  const setup = hubSetup(store, hub.id, { token: "private-owner-link-".repeat(4), expiresAt: Date.now() + 86400000 });
  const initialized = setup.prepare("private-owner-link-".repeat(4));
  const owner = accounts.finish({ connection:"google",method:"google",subject:"owner",tenant:null,email:"owner@example.test",name:"Owner" },
    "provider-browser",undefined,(state,session)=>setup.complete(state,session,initialized.id));
  // A valid browser session may be older than the former device-enrollment freshness gate.
  const authenticatedAt = Date.now() - 600001;
  store.change(state => { state.identity.sessions.find(session=>session.id===owner.session.id)!.context.authenticatedAt=authenticatedAt; });
  const authority = new Authority(store,accounts,new Tokens(origin,await signingKey()));
  const app = await createIdentityApp({authority,localHubId:hub.id,setup,secureCookies:false,
    providers:[{id:"google",method:"google",async authorize(){throw Error("Existing sessions need no provider exchange");},async exchange(){throw Error("unused");}}],
    clients:[{id:"web-client",redirectUris:["https://client.test/auth-callback"]}]});
  try {
    const verifier="v".repeat(43), query=new URLSearchParams({client_id:"web-client",redirect_uri:"https://client.test/auth-callback",
      response_type:"code",state:"client-browser-state-123456789",code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
    async function login(installationId:string) {
      const authorized=await app.inject({method:"GET",url:"/oauth/authorize?"+query,cookies:{codoxear_identity:owner.credential}});
      assert.equal(authorized.statusCode,302,authorized.body);
      const callback=new URL(authorized.headers.location!);assert.equal(callback.origin,"https://client.test");
      const exchanged=await app.inject({method:"POST",url:"/oauth/token",payload:{grant_type:"authorization_code",client_id:"web-client",
        redirect_uri:"https://client.test/auth-callback",code:callback.searchParams.get("code"),code_verifier:verifier,installation_id:installationId}});
      assert.equal(exchanged.statusCode,200,exchanged.body);return exchanged.json();
    }
    const a=await login("phone"),b=await login("tablet");
    const request=(accessToken:string)=>app.inject({method:"GET",url:"/api/v1/me",headers:{authorization:"Bearer "+accessToken}});
    assert.equal((await request(a.access_token)).json().hubRole,"owner");
    const rotated=await app.inject({method:"POST",url:"/oauth/token",payload:{grant_type:"refresh_token",refresh_token:a.refresh_token}});
    assert.equal(rotated.statusCode,200,rotated.body);
    assert.equal((await request(rotated.json().access_token)).json().context.authenticatedAt,authenticatedAt);
    const reused=await app.inject({method:"POST",url:"/oauth/token",payload:{grant_type:"refresh_token",refresh_token:a.refresh_token}});
    assert.equal(reused.statusCode,401);assert.equal((await request(rotated.json().access_token)).statusCode,401);
    assert.equal((await request(b.access_token)).statusCode,200);
    const revoke=await app.inject({method:"POST",url:"/oauth/revoke",payload:{token:b.refresh_token}});
    assert.equal(revoke.statusCode,200);assert.equal((await request(b.access_token)).statusCode,401);
    assert.equal((await app.inject({method:"POST",url:"/oauth/token",payload:{grant_type:"refresh_token",refresh_token:b.refresh_token}})).statusCode,401);
    assert.equal(accounts.session(owner.credential).userId,owner.session.userId);
    assert.equal((await app.inject({method:"POST",url:"/api/v1/auth/logout",cookies:{codoxear_identity:owner.credential}})).statusCode,200);
    assert.throws(()=>accounts.session(owner.credential),/Session/);
    for(const path of ["/api/v1/auth/keys/challenge","/api/v1/auth/keys/verify","/api/v1/auth/setup"])
      assert.equal((await app.inject({method:"POST",url:path,payload:{}})).statusCode,404);
    assert.equal(Object.hasOwn(store.read().identity,"deviceKeys"),false);
  } finally {await app.close();store.close();}
});
