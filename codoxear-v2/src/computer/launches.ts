import { z } from "zod";
import { DomainError } from "../contracts/model.js";
import { LaunchResult, type Operation } from "../contracts/tunnel.js";
import { SqliteDocument } from "../persistence/document.js";

type Receipt =
  | { state: "unknown" }
  | { state: "ready"; result: z.infer<typeof LaunchResult> };

/** Commit an uncertainty barrier BEFORE launch; receipt lookup never launches work. */
export class ComputerLaunches {
  private document: SqliteDocument<
    Array<{ agentId: string; receipt: Receipt }>
  >;
  constructor(path: string, binding: string) {
    this.document = new SqliteDocument(path, binding, () => []);
  }
  status(agentId: string): Receipt {
    return (
      this.document.read().find((r) => r.agentId === agentId)?.receipt ?? {
        state: "unknown",
      }
    );
  }
  async create(
    operation: Extract<Operation, { op: "create" }>,
    execute: () => Promise<unknown>,
  ) {
    this.document.change((receipts) => {
      if (receipts.some((r) => r.agentId === operation.agentId))
        throw new DomainError(
          409,
          "launch_recorded",
          "Launch already recorded; check its result before creating another agent",
        );
      // Do not evict replay barriers. Exhaustion rejects before dispatch.
      if (receipts.length >= 10000)
        throw new DomainError(
          409,
          "launch_limit",
          "Computer launch journal is full",
        );
      receipts.push({
        agentId: operation.agentId,
        receipt: { state: "unknown" },
      });
    });
    const result = LaunchResult.parse(await execute());
    this.document.change((receipts) => {
      receipts.find((r) => r.agentId === operation.agentId)!.receipt = {
        state: "ready",
        result,
      };
    });
    return result;
  }
  close() {
    this.document.close();
  }
}
