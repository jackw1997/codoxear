import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { oarInputId } from "../src/computer/managed/input-id.js";

assert.ok(existsSync("/.dockerenv"), "Managed verification runs only in Docker");
test("opaque durable receipts map to stable distinct OAR UUIDs", () => {
  const first = oarInputId("native-send");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(oarInputId("native-send"), first);
  assert.notEqual(oarInputId("native-resume"), first);
  assert.equal(oarInputId("9CCF3C4A-B933-4624-9702-836AF35B8D7F"), "9CCF3C4A-B933-4624-9702-836AF35B8D7F");
});
