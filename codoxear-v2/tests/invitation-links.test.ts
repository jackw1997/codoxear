import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { createHub, passwordHash, transferOwner, setHubMemberRole, removeMember, invite } from "../src/domain/commands.js";
import { createAllowedComputer } from "../scripts/testing/authorized-fixtures.js";
import { createInvitationLink, acceptInvitationLink, inspectInvitationLink, revokeInvitationLink } from "../src/domain/invitation-links.js";
import { InvitationLinkCreated, InvitationLinkList, InvitationLinkSummary, InvitationLinkAccepted, InvitationLinkRequest } from "../src/contracts/invitations.js";
import { registeredContract } from "../src/protocol/inventory.js";
assert.ok(existsSync("/.dockerenv"), "Invitation behavior runs in Docker");

async function fixture() {
  const store = new Store(":memory:"), origin = "https://invitation-links.test";
  const hub = store.change(s => {
    s.users.push({id:"owner",name:"Owner",email:"owner@example.test",disabled:false,passwordHash:passwordHash("fixture-password")});
    const h = createHub(s,"owner","Join this Hub");
    createAllowedComputer(s,"owner",h.id,"Private Computer","owner");
    return h;
  });
  const local = await independentAuthority({origin,hubId:hub.id,store,secureCookies:false});
  const accounts = local.authority.accounts;
  const ownerLogin = accounts.password("owner@example.test","fixture-password","fixture");
  const owner = accounts.finish({method:"google",connection:"google",subject:"owner-subject",tenant:null,email:"owner@example.test",name:"Owner"},"owner-browser",ownerLogin.session.id);
  const sessions = new HubSessions(":memory:");
  const app = await createHubApp({origin,authority:local.client,localIdentity:local.identity,sessions,tunnels:new Tunnels(),secureCookies:false});
  const ownerToken = await local.authority.tokens.issue(owner.session,origin,"identity_access");
  async function recipient(subject: string, method: "google" | "feishu" = "google", tenant: string | null = null) {
    const signed = accounts.finish({method,connection:method,subject,tenant,email:subject+"@example.test",name:subject},subject+"-browser");
    return { ...signed, token: await local.authority.tokens.issue(signed.session,origin,"identity_access") };
  }
  async function request(method: "GET"|"POST"|"DELETE", url: string, token?: string, payload?: Record<string, unknown>) {
    return app.inject({method,url,...(token ? {headers:{authorization:"Bearer "+token}}:{}),...(payload!==undefined?{payload}: {})});
  }
  return {store,hub,local,ownerToken,recipient,request,
    async close(){await app.close();await local.identity.close();sessions.close();store.close();}};
}

test("Owner creates shareable link before recipient exists; public preview and explicit provider acceptance grant only Member once", async () => {
  const f = await fixture();
  try {
    const url = `/api/hubs/${f.hub.id}/invitation-links`;
    const created = await f.request("POST",url,f.ownerToken,{});
    assert.equal(created.statusCode,200);
    const link = InvitationLinkCreated.parse(created.json());
    assert.equal(f.store.read().users.length,1);
    assert.equal(link.role,"member");
    assert.equal(link.expiresAt-link.createdAt,86400000);
    const preview = await f.request("GET",`/api/invitation-links/${link.token}`);
    assert.equal(preview.statusCode,200);
    assert.deepEqual(InvitationLinkSummary.parse(preview.json()),Object.fromEntries(Object.entries(link).filter(([key])=>key!=="token")));
    assert.equal("tokenHash" in preview.json(),false);
    const denied = await f.request("POST",`/api/invitation-links/${link.token}/accept`,undefined,{});
    assert.equal(denied.statusCode,401);
    const own = await f.request("POST",`/api/invitation-links/${link.token}/accept`,f.ownerToken,{});
    assert.equal(own.statusCode,409);
    assert.equal(own.json().code,"already_member");
    assert.equal(f.store.read().invitationLinks[0]!.acceptedAt,null);
    const member = await f.recipient("member");
    const before = await f.request("POST","/api/v1/hub-token",member.token,{hubId:f.hub.id});
    assert.equal(before.statusCode,403);
    const accepted = await f.request("POST",`/api/invitation-links/${link.token}/accept`,member.token,{});
    assert.equal(accepted.statusCode,200);
    InvitationLinkAccepted.parse(accepted.json());
    const s = f.store.read();
    assert.deepEqual(s.memberships.filter(v=>v.userId===member.session.userId),[{resource:"hub",resourceId:f.hub.id,userId:member.session.userId,role:"member"}]);
    assert.equal(s.identity.workspaceGrants.some(v=>v.userId===member.session.userId),false);
    assert.equal(s.agentGrants.some(v=>v.userId===member.session.userId),false);
    assert.equal((await f.request("POST","/api/v1/hub-token",member.token,{hubId:f.hub.id})).statusCode,200);
    const other = await f.recipient("other");
    const used = await f.request("POST",`/api/invitation-links/${link.token}/accept`,other.token,{});
    assert.equal(used.statusCode,409);
    assert.equal(used.json().code,"invitation_accepted");
    assert.equal((await f.request("GET",url,member.token)).statusCode,403);
    assert.equal((await f.request("POST",url,member.token,{})).statusCode,403);
    const list = InvitationLinkList.parse((await f.request("GET",url,f.ownerToken)).json());
    assert.equal(list.invitations[0]!.status,"accepted");
    assert.equal("token" in list.invitations[0]!,false);
    assert.equal((await f.request("POST",url,f.ownerToken,{role:"admin"})).statusCode,400);
    const obsolete = await f.request("POST",`/api/resources/hub/${f.hub.id}/invitations`,f.ownerToken,{email:"someone@example.test",role:"admin"});
    assert.equal(obsolete.statusCode,409);
    assert.equal(obsolete.json().code,"hub_invitation_link_required");
    const oldAdmin = f.store.change(s=>invite(s,"owner","hub",f.hub.id,"other@example.test","admin"));
    const legacyAccept = await f.request("POST","/api/v1/invitations/accept",other.token,{token:oldAdmin.token});
    assert.equal(legacyAccept.statusCode,409);
    assert.equal(legacyAccept.json().code,"hub_invitation_link_required");
    assert.equal(f.store.read().invitations.find(value=>value.id===oldAdmin.invitation.id)!.accepted,false);
    const raced = InvitationLinkCreated.parse((await f.request("POST",url,f.ownerToken,{})).json());
    const another = await f.recipient("another");
    const results = await Promise.all([other, another].map(value =>
      f.request("POST",`/api/invitation-links/${raced.token}/accept`,value.token,{})));
    assert.deepEqual(results.map(value=>value.statusCode).sort(),[200,409]);
    assert.equal(f.store.read().memberships.filter(value=>value.resource==="hub" &&
      [other.session.userId,another.session.userId].includes(value.userId)).length,1);
  } finally {await f.close();}
});

test("Invitation creation is bounded per issuer and retains accepted token fences after reload", async () => {
  const f = await fixture();
  try {
    const start = Date.now();
    const links: ReturnType<typeof createInvitationLink>[] = [];
    for (let i=0;i<10;i++) links.push(f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,24,start)));
    assert.throws(()=>f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,24,start)),/Wait before creating/);
    const guest = await f.recipient("durable");
    f.store.change(s=>acceptInvitationLink(s,guest.session.userId,links[0]!.token,f.hub.id,start));
    assert.equal(inspectInvitationLink(f.store.read(),links[0]!.token,f.hub.id,start).status,"accepted");
    assert.equal(f.store.read().invitationLinks.find(v=>v.id===links[0]!.id)!.acceptedBy,guest.session.userId);
  } finally {await f.close();}
});

test("Admin may create and revoke Member links; revocation and changed issuer authority fence acceptance", async () => {
  const f = await fixture();
  try {
    const admin = await f.recipient("admin"), guest = await f.recipient("guest");
    f.store.change(s=>s.memberships.push({resource:"hub",resourceId:f.hub.id,userId:admin.session.userId,role:"admin"}));
    const url = `/api/hubs/${f.hub.id}/invitation-links`;
    const link = InvitationLinkCreated.parse((await f.request("POST",url,admin.token,{expiresInHours:1})).json());
    assert.equal((await f.request("DELETE",url+"/"+link.id,guest.token)).statusCode,403);
    assert.equal((await f.request("DELETE",url+"/"+link.id,admin.token)).statusCode,200);
    assert.equal((await f.request("GET",`/api/invitation-links/${link.token}`)).json().status,"revoked");
    const rejected = await f.request("POST",`/api/invitation-links/${link.token}/accept`,guest.token,{});
    assert.equal(rejected.statusCode,409);
    assert.equal(rejected.json().code,"invitation_revoked");
    const stale = InvitationLinkCreated.parse((await f.request("POST",url,admin.token,{})).json());
    f.store.change(s=>setHubMemberRole(s,"owner",f.hub.id,admin.session.userId,"member"));
    f.store.change(s=>setHubMemberRole(s,"owner",f.hub.id,admin.session.userId,"admin"));
    assert.equal((await f.request("POST",`/api/invitation-links/${stale.token}/accept`,guest.token,{})).json().code,"invitation_revoked");
    assert.equal(f.store.read().invitationLinks.find(v=>v.id===stale.id)!.acceptedAt,null);
    const removed = InvitationLinkCreated.parse((await f.request("POST",url,admin.token,{})).json());
    f.store.change(s=>removeMember(s,"owner","hub",f.hub.id,admin.session.userId));
    f.store.change(s=>s.memberships.push({resource:"hub",resourceId:f.hub.id,userId:admin.session.userId,role:"admin"}));
    assert.equal((await f.request("POST",`/api/invitation-links/${removed.token}/accept`,guest.token,{})).json().code,"invitation_revoked");
    const disabled = InvitationLinkCreated.parse((await f.request("POST",url,admin.token,{})).json());
    f.store.change(s=>{s.users.find(v=>v.id===admin.session.userId)!.disabled=true;});
    assert.equal((await f.request("POST",`/api/invitation-links/${disabled.token}/accept`,guest.token,{})).json().code,"invitation_authority_changed");

  } finally {await f.close();}
});

test("Acceptance enforces allowed provider and bound Feishu organization without spending the link", async () => {
  const f = await fixture();
  try {
    const link = InvitationLinkCreated.parse((await f.request("POST",`/api/hubs/${f.hub.id}/invitation-links`,f.ownerToken,{})).json());
    const google = await f.recipient("google-guest"), wrong = await f.recipient("wrong-team","feishu","wrong"), correct = await f.recipient("correct-team","feishu","team");
    f.store.change(s=>{s.identity.hubOrganizations=[{hubId:f.hub.id,feishuConnection:"feishu",feishuTenant:"team",allowedMethods:["feishu"]}];});
    assert.equal((await f.request("POST",`/api/invitation-links/${link.token}/accept`,google.token,{})).json().code,"login_method_not_allowed");
    assert.equal((await f.request("POST",`/api/invitation-links/${link.token}/accept`,wrong.token,{})).json().code,"wrong_organization");
    assert.equal(f.store.read().invitationLinks[0]!.acceptedAt,null);
    f.store.change(s=>s.identity.requirements.push({hubId:f.hub.id,rule:{method:"feishu",connection:"other-connection",maxAgeSeconds:60}}));
    const required = await f.request("POST",`/api/invitation-links/${link.token}/accept`,correct.token,{});
    assert.equal(required.statusCode,401);
    assert.equal(required.json().code,"reauthentication_required");
    assert.equal(f.store.read().invitationLinks[0]!.acceptedAt,null);
    f.store.change(s=>{s.identity.requirements=[];});
    assert.equal((await f.request("POST",`/api/invitation-links/${link.token}/accept`,correct.token,{})).statusCode,200);
  } finally {await f.close();}
});

test("Links expire precisely, survive reload, keep existing roles, and cap active creation", async () => {
  const f = await fixture();
  try {
    const guest = await f.recipient("clock-guest");
    const start = 100000;
    const link = f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,1,start));
    assert.equal(inspectInvitationLink(f.store.read(),link.token,f.hub.id,start+3599999).status,"pending");
    assert.throws(()=>f.store.change(s=>acceptInvitationLink(s,guest.session.userId,link.token,f.hub.id,start+3600000)),/expired/);
    assert.equal(f.store.read().invitationLinks[0]!.acceptedAt,null);
    assert.throws(()=>f.store.change(s=>acceptInvitationLink(s,"owner",link.token,f.hub.id,start)),/already belongs/);
    for (let i=0;i<100;i++) f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,168,start+4000000+i*61000));
    assert.throws(()=>f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,168,start+4000000+101*61000)),/Revoke/);
    const pending = f.store.read().invitationLinks.find(v=>v.createdAt>start)!;
    f.store.change(s=>revokeInvitationLink(s,"owner",f.hub.id,pending.id,start+4000000+102*61000));
    f.store.change(s=>createInvitationLink(s,"owner",f.hub.id,168,start+4000000+103*61000));
    const latest = f.store.read().invitationLinks.at(-1)!;
    f.store.change(s=>{s.memberships.push({resource:"hub",resourceId:f.hub.id,userId:guest.session.userId,role:"member"});transferOwner(s,"owner","hub",f.hub.id,guest.session.userId);});
    assert.equal(inspectInvitationLink(f.store.read(), f.store.change(s=>createInvitationLink(s,guest.session.userId,f.hub.id,24,start+10000000)).token,f.hub.id,start+10000000).status,"pending");
    assert.equal(latest.ownerRevision < f.store.read().hubs[0]!.revision,true);
    assert.equal(InvitationLinkRequest.safeParse({expiresInHours:0}).success,false);
    assert.equal(InvitationLinkRequest.safeParse({expiresInHours:169}).success,false);
    assert.equal(registeredContract("hub").find(v=>v.path==="/api/invitation-links/:token")!.auth,"public");
  } finally {await f.close();}
});
