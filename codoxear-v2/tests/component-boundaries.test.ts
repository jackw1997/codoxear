import assert from "node:assert/strict";
import test from "node:test";
import { auditComponentBoundaries, type ComponentManifest } from "../scripts/check-boundaries.js";

const computer: ComponentManifest = {
  role: "computer",
  entries: ["src/computer/main.ts"],
  sharedLibraries: ["src/contracts", "src/protocol", "src/persistence"],
};
const peerManifests: ComponentManifest[] = [
  computer,
  { role: "hub", entries: ["src/hub/api.ts"], sharedLibraries: ["src/contracts"] },
  { role: "identity", entries: ["src/identity/model.ts"], sharedLibraries: ["src/contracts"] },
];

function audit(source: Record<string, string>, manifests: readonly ComponentManifest[] = [computer]): string[] {
  return auditComponentBoundaries(new Map(Object.entries(source)), manifests);
}

test("Computer closure permits declared contracts, protocol, and generic persistence sources", () => {
  const violations = audit({
    "src/computer/main.ts": "import { Contract } from '../contracts/api.js'; import { routes } from '../protocol/routes.js'; import { document } from '../persistence/document.js';",
    "src/contracts/api.ts": "export interface Contract {}",
    "src/protocol/routes.ts": "export const routes = [];",
    "src/persistence/document.ts": "export const document = {};",
  });
  assert.deepEqual(violations, []);
});

test("Computer closure rejects Hub, Identity, and frontend sources", () => {
  const violations = audit({
    "src/computer/main.ts": "import '../hub/api.js'; import '../identity/model.js'; import '../../frontend/web/api.js';",
    "src/hub/api.ts": "export {};",
    "src/identity/model.ts": "export {};",
    "frontend/web/api.ts": "export {};",
  }, peerManifests);
  assert(violations.some((value) => value.includes("component hub")));
  assert(violations.some((value) => value.includes("component identity")));
  assert(violations.some((value) => value.includes("undeclared source library frontend/web/api.ts")));
});

test("Computer closure does not inherit auth, domain, or presentation libraries", () => {
  const violations = audit({
    "src/computer/main.ts": "import '../auth/tokens.js'; import '../domain/policy.js'; import '../presentation/view.js';",
    "src/auth/tokens.ts": "export {};",
    "src/domain/policy.ts": "export {};",
    "src/presentation/view.ts": "export {};",
  });
  assert(violations.some((value) => value.includes("undeclared source library src/auth/tokens.ts")));
  assert(violations.some((value) => value.includes("undeclared source library src/domain/policy.ts")));
  assert(violations.some((value) => value.includes("undeclared source library src/presentation/view.ts")));
});

test("a declared shared library cannot hide a transitive backedge into another component", () => {
  const violations = audit({
    "src/computer/main.ts": "import '../protocol/facade.js';",
    "src/protocol/facade.ts": "export * from '../hub/authority.js';",
    "src/hub/authority.ts": "export {};",
  }, [computer, { role: "hub", entries: ["src/hub/authority.ts"], sharedLibraries: ["src/contracts"] }]);
  assert(violations.some((value) => value.includes("component hub src/hub/authority.ts")));
});

test("Hub and Identity may use their declared auth/domain/presentation libraries", () => {
  const manifests: ComponentManifest[] = [
    { role: "hub", entries: ["src/hub/main.ts"], sharedLibraries: ["src/auth", "src/domain", "src/contracts", "src/persistence", "src/presentation", "src/protocol"] },
    { role: "identity", entries: ["src/identity/main.ts"], sharedLibraries: ["src/auth", "src/domain", "src/contracts", "src/persistence", "src/presentation", "src/protocol"] },
  ];
  const violations = audit({
    "src/hub/main.ts": "import '../auth/accounts.js'; import '../domain/policy.js'; import '../presentation/view.js';",
    "src/identity/main.ts": "import '../auth/accounts.js'; import '../domain/policy.js'; import '../presentation/view.js';",
    "src/auth/accounts.ts": "export {};",
    "src/domain/policy.ts": "export {};",
    "src/presentation/view.ts": "export {};",
  }, manifests);
  assert.deepEqual(violations, []);
});

for (const [kind, statement] of [
  ["type import", "type Hidden = import('../hub/api.js').Hidden;"],
  ["CommonJS require", "const hidden = require('../hub/api.js');"],
  ["dynamic import", "const hidden = import('../hub/api.js');"],
] as const) {
  test(`closure follows ${kind} edges into peer components`, () => {
    const violations = audit({
      "src/computer/main.ts": "import '../protocol/facade.js';",
      "src/protocol/facade.ts": statement,
      "src/hub/api.ts": "export interface Hidden {}",
    }, peerManifests.filter((manifest) => manifest.role !== "identity"));
    assert(violations.some((value) => value.includes("component hub src/hub/api.ts")));
  });
}

test("shared libraries reject backedges into their consuming component even when already visited", () => {
  const violations = audit({
    "src/computer/main.ts": "import '../protocol/facade.js';",
    "src/protocol/facade.ts": "export * from '../computer/main.js';",
  });
  assert.deepEqual(violations, [
    "computer: shared library cannot import its component: src/protocol/facade.ts → src/computer/main.ts",
  ]);
});

test("AST extraction ignores import-like strings and comments", () => {
  const violations = audit({
    "src/computer/main.ts": `
      // require('../hub/api.js');
      const example = "type Hidden = import('../hub/api.js').Hidden;";
      const documentation = "require('../hub/api.js')";
    `,
  });
  assert.deepEqual(violations, []);
});
