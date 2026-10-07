import "./testing/frontend-artifact.js";
import type { RouteOptions } from "fastify";
import { Store } from "../src/persistence/store.js";
import { createHub, createComputer, passwordHash, secret } from "../src/domain/commands.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { DelegationStore } from "../src/hub/delegation.js";
export type RegisteredRoute = { method: string; path: string; websocket: boolean };
export const routeCollector = (routes: RegisteredRoute[]) => (route: RouteOptions) => {
  for (const method of Array.isArray(route.method) ? route.method : [route.method])
    routes.push({method, path: route.url, websocket: !!route.websocket});
};
export async function protocolFixture() {
  const store = new Store(":memory:");
  store.change(s => s.users.push({id:"owner",email:"owner@fixture.invalid",name:"Owner",passwordHash:passwordHash("fixture-isolated-password"),disabled:false}));
  const computer = store.change(s => createComputer(s,"owner",createHub(s,"owner","Protocol fixture").id,"Computer","owner"));
  const identityRoutes: RegisteredRoute[] = [], hubRoutes: RegisteredRoute[] = [];
  const origin = "https://protocol.fixture.invalid";
  const local = await independentAuthority({origin,hubId:computer.computer.hubId,store,otpKey:secret(),secureCookies:false,routeObserver:routeCollector(identityRoutes)});
  const sessions = new HubSessions(":memory:"), tunnels = new Tunnels(), delegations = new DelegationStore(":memory:");
  const notifications = new NotificationInbox(":memory:",computer.computer.hubId,async (sid,aid,cid,binding)=>{local.authority.authorizeNotification(computer.computer.hubId,sid,aid,cid,binding);});
  const hub = await createHubApp({origin,localIdentity:local.identity,authority:local.client,sessions,tunnels,notifications,delegations,secureCookies:false,routeObserver:routeCollector(hubRoutes),clientOrigins:["https://client.fixture.invalid"]});
  await hub.ready(); await local.identity.ready();
  const session = local.authority.accounts.password("owner@fixture.invalid","fixture-isolated-password","fixture").session;
  const bearer = await local.authority.tokens.issue(session,origin,"identity_access");
  return {hub,identity:local.identity,authority:local.authority,computer:computer.computer,store,session,bearer,origin,hubRoutes,identityRoutes,
    async close() {await hub.close();await local.identity.close();delegations.close();notifications.close();sessions.close();store.close();},
  };
}
