import {
  createComputer,
  setComputerAccess,
} from "../../src/domain/commands.js";
import type { State } from "../../src/contracts/model.js";

/** Fixtures explicitly opt their Computer owner into execution; production admission never does. */
export function createAllowedComputer(
  state: State,
  actorId: string,
  hubId: string,
  name: string,
  ownerId: string,
) {
  const result = createComputer(state, actorId, hubId, name, ownerId);
  setComputerAccess(state, actorId, result.computer.id, ownerId, "write");
  return result;
}
