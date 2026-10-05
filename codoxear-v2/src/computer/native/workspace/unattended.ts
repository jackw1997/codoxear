import { readSettings } from "./settings.js";
import type { ChatEvent } from "../types.js";
export function unattendedIdleAllowsInjection(
  events: ChatEvent[],
  cooldownMinutes: number,
  lastInjection: number,
  now = Date.now(),
): boolean {
  const last = events
    .filter(
      (event) =>
        event.role === "user" ||
        (event.role === "assistant" &&
          event.message_class === "final_response"),
    )
    .at(-1);
  const cooldown = cooldownMinutes * 60000;
  return (
    !!last &&
    last.role === "assistant" &&
    now - last.ts * 1000 >= cooldown &&
    (!lastInjection || now - lastInjection >= cooldown)
  );
}
export const DEFAULT_UNATTENDED_PROMPT =
  "Unattended-mode operating constitution\n\n1. Recall the objective.\nWhat is the user's goal? What does done look like? Ground every action in the original intent, not in process artifacts. When in doubt, return to the objective.\n\n2. Understand current status.\nWhat has been accomplished? What evidence exists? Compare the actual state of the world against the desired state. Be honest about gaps — wishful thinking wastes turns.\n\n3. Replan toward the objective.\nGiven the current status, what is the shortest path to the objective? Adjust the plan based on new evidence. Eliminate work that does not serve the goal. Prioritize the highest-leverage next action over the most comfortable one.\n\n4. Continue execution with delegation.\nExecute the plan. Delegate bounded work to subagents when parallelizable. Maintain ownership of integration and judgment. Verify delegated results against the objective, not against the subagent's self-assessment.\n\nOperating principles:\n- Maximize useful progress per turn. This is not about minimizing turns — it is about maximizing signal per turn.\n- Verification is mandatory. Claims must be grounded in evidence, not assertion.\n- Delegation is a first-class tool. Dispatch subagents for bounded execution while the main agent owns decisions, integration, and the causal model.\n- Learn from failure. When an approach fails, understand why before trying the next thing. A failed result is evidence — use it.\n- Yield control to the user only when: the objective is met, a genuine user decision is required, or the next action is irreversible and high-risk. Otherwise, continue.\n";
export async function readUnattendedPrompt(stateHome: string): Promise<string> {
  const state = await readSettings(stateHome);
  return typeof state.unattended === "string" && state.unattended.trim()
    ? state.unattended
    : DEFAULT_UNATTENDED_PROMPT;
}
