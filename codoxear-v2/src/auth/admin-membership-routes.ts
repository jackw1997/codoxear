import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, forbid, requireValue } from "../contracts/model.js";
import { hubRole, canManageHub } from "../domain/policy.js";
import {
  setHubMemberRole,
  setComputerAccess,
  removeMember,
} from "../domain/commands.js";
import type { Authority } from "./authority.js";
import type { IdentitySession } from "./model.js";

/** Hub administration is independent of explicit Computer execution access. */
export function registerAdminMembershipRoutes(
  app: FastifyInstance,
  authority: Authority,
  session: (
    request: FastifyRequest,
  ) => Promise<IdentitySession> | IdentitySession,
) {
  const params = z.object({ id: Id, userId: Id.optional() });
  app.get("/api/v1/hubs/:id/members", async (r) => {
    const current = await session(r),
      { id } = params.parse(r.params);
    const hub = authority.context(current, id),
      state = authority.store.read();
    forbid(
      canManageHub(state, current.userId, hub),
      "Only Hub owners and admins can list members",
    );
    return {
      hubId: id,
      role: hubRole(state, current.userId, hub),
      members: state.users
        .filter((u) => hubRole(state, u.id, hub) !== null)
        .map((u) => ({
          userId: u.id,
          name: u.name,
          role: hubRole(state, u.id, hub),
        })),
    };
  });
  app.put("/api/v1/hubs/:id/members/:userId", async (r) => {
    const current = await session(r),
      { id, userId } = params.parse(r.params),
      { role } = z
        .object({ role: z.enum(["admin", "member"]) })
        .strict()
        .parse(r.body);
    authority.context(current, id);
    authority.store.change((s) =>
      setHubMemberRole(s, current.userId, id, userId!, role),
    );
    return { ok: true };
  });
  app.delete("/api/v1/hubs/:id/members/:userId", async (r) => {
    const current = await session(r),
      { id, userId } = params.parse(r.params);
    authority.context(current, id);
    authority.store.change((s) =>
      removeMember(s, current.userId, "hub", id, userId!),
    );
    return { ok: true };
  });
  const computerContext = async (r: FastifyRequest) => {
    const current = await session(r),
      { id, userId } = params.parse(r.params),
      state = authority.store.read(),
      computer = requireValue(state.computers.find((c) => c.id === id)),
      hub = authority.context(current, computer.hubId);
    forbid(
      canManageHub(state, current.userId, hub),
      "Only Hub owners and admins can manage Computer allowlists",
    );
    return { current, id, userId, state };
  };
  app.get("/api/v1/computers/:id/allowlist", async (r) => {
    const { id, state } = await computerContext(r);
    return {
      computerId: id,
      canManage: true,
      entries: state.memberships
        .filter((m) => m.resource === "computer" && m.resourceId === id)
        .map((m) => ({
          userId: m.userId,
          name: state.users.find((u) => u.id === m.userId)?.name ?? m.userId,
          access: m.role === "operator" ? "write" : "read",
        })),
    };
  });
  app.put("/api/v1/computers/:id/allowlist/:userId", async (r) => {
    const { current, id, userId } = await computerContext(r),
      { access } = z
        .object({ access: z.enum(["read", "write"]) })
        .strict()
        .parse(r.body);
    authority.store.change((s) =>
      setComputerAccess(s, current.userId, id, userId!, access),
    );
    return { ok: true };
  });
  app.delete("/api/v1/computers/:id/allowlist/:userId", async (r) => {
    const { current, id, userId } = await computerContext(r);
    authority.store.change((s) =>
      removeMember(s, current.userId, "computer", id, userId!),
    );
    return { ok: true };
  });
}
