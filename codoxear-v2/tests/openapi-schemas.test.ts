import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  collectSchemaNodes,
  resolveSchemaReferences,
  reuseSchemas,
} from "../scripts/openapi-schemas.js";

test("shared schemas preserve nested validation and original named components", () => {
  const schema = (): Parameters<typeof z.fromJSONSchema>[0] => ({
    type: "object",
    properties: {
      label: {
        type: "string",
        pattern: "^[A-Z]+$",
        minLength: 2,
        maxLength: 4,
      },
      count: { type: "integer", minimum: 1, maximum: 3 },
      flags: { type: "array", items: { enum: ["read", "write"] }, maxItems: 2 },
    },
    required: ["label", "count"],
    additionalProperties: false,
  });
  const original = {
    openapi: "3.1.0",
    paths: {
      "/sample": {
        post: {
          requestBody: {
            content: { "application/json": { schema: schema() } },
          },
        },
      },
    },
    components: { schemas: { Sample: schema(), Alias: schema() } },
  };
  const nodes = new Set<Record<string, any>>();
  for (const value of [
    original.paths["/sample"].post.requestBody.content["application/json"]
      .schema,
    ...Object.values(original.components.schemas),
  ])
    collectSchemaNodes(value, nodes);
  const compact = reuseSchemas(original, nodes);
  assert.deepEqual(
    compact.paths["/sample"].post.requestBody.content["application/json"]
      .schema,
    { $ref: "#/components/schemas/Sample" },
  );
  assert.deepEqual(compact.components.schemas.Alias, {
    $ref: "#/components/schemas/Sample",
  });
  assert.deepEqual(resolveSchemaReferences(compact), original);
  const validator = z.fromJSONSchema(
    resolveSchemaReferences(compact).components.schemas.Sample,
  );
  assert.equal(
    validator.safeParse({ label: "AB", count: 2, flags: ["read"] }).success,
    true,
  );
  for (const value of [
    { label: "a", count: 2 },
    { label: "ABCDE", count: 2 },
    { label: "AB", count: 0 },
    { label: "AB", count: 2, extra: true },
    { label: "AB", count: 2, flags: ["admin"] },
  ])
    assert.equal(validator.safeParse(value).success, false);
});

test("schema collection keeps property maps and data annotations inline", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    default: { type: "object" },
    examples: [{ type: "object" }],
  };
  const nodes = new Set<Record<string, any>>();
  collectSchemaNodes(schema, nodes);
  assert.equal(nodes.size, 2);
  assert.equal(nodes.has(schema.properties), false);
  assert.equal(nodes.has(schema.default), false);
  assert.equal(nodes.has(schema.examples[0]!), false);
  assert.throws(
    () => collectSchemaNodes({ $id: "urn:separate", type: "string" }, nodes),
    /scoped schemas/,
  );
});

test("component resolution decodes pointers and rejects broken or recursive references", () => {
  assert.deepEqual(
    resolveSchemaReferences({
      components: { schemas: { "A/B~C": { type: "string" } } },
      schema: { $ref: "#/components/schemas/A~1B~0C" },
    }).schema,
    { type: "string" },
  );
  assert.throws(
    () =>
      resolveSchemaReferences({
        schema: { $ref: "#/components/schemas/Missing" },
      }),
    /Missing schema/,
  );
  assert.throws(
    () =>
      resolveSchemaReferences({
        components: {
          schemas: { Cycle: { $ref: "#/components/schemas/Cycle" } },
        },
      }),
    /Recursive schema/,
  );
});
