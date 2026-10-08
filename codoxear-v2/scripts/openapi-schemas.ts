import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, any>;

/** OpenAPI schema references are document-relative. Resolve them before passing
 * a detached schema to a JSON Schema consumer such as Zod. */
export function resolveSchemaReferences<T>(document: T): T {
  const source = document as JsonObject;
  const resolved = new Map<string, unknown>();
  const active = new Set<string>();
  const visit = (value: any): any => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string") {
      const reference = value.$ref;
      if (!reference.startsWith("#/components/schemas/"))
        throw Error("Unsupported schema reference: " + reference);
      if (Object.keys(value).length !== 1)
        throw Error(
          "Schema reference siblings require JSON Schema conjunction",
        );
      if (active.has(reference)) throw Error("Recursive schema: " + reference);
      if (!resolved.has(reference)) {
        active.add(reference);
        let target: any = source;
        for (const token of reference.slice(2).split("/"))
          target = target?.[token.replaceAll("~1", "/").replaceAll("~0", "~")];
        if (target === undefined) throw Error("Missing schema: " + reference);
        resolved.set(reference, visit(target));
        active.delete(reference);
      }
      return resolved.get(reference);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(document);
}

/** Register schema objects, never property maps, examples or default values. */
export function collectSchemaNodes(schema: any, nodes: Set<JsonObject>): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  // Moving a schema with its own reference scope requires a different rewrite.
  // Fail visibly if future contracts introduce one rather than change its meaning.
  if (
    ["$ref", "$id", "$anchor", "$dynamicAnchor", "$dynamicRef"].some(
      (key) => key in schema,
    )
  )
    throw Error(
      "Schema factoring does not support independently scoped schemas",
    );
  nodes.add(schema);
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ])
    for (const child of Object.values(schema[key] ?? {}))
      collectSchemaNodes(child, nodes);
  for (const key of [
    "items",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "contentSchema",
    "unevaluatedProperties",
    "unevaluatedItems",
  ])
    collectSchemaNodes(schema[key], nodes);
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
    for (const child of schema[key] ?? []) collectSchemaNodes(child, nodes);
}

/** Factor identical structural schemas into readable, standard OpenAPI
 * components. Pretty printing and all validation keywords remain intact. */
export function reuseSchemas<T extends { components: { schemas: JsonObject } }>(
  document: T,
  nodes: Set<JsonObject>,
): T {
  const groups = new Map<
    string,
    { count: number; schema: JsonObject; name?: string }
  >();
  const keys = new Map<JsonObject, string>();
  for (const schema of nodes) {
    const key = JSON.stringify(schema);
    keys.set(schema, key);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { count: 1, schema });
  }
  const originalComponents = document.components.schemas;
  for (const [name, schema] of Object.entries(originalComponents)) {
    const group = groups.get(keys.get(schema)!);
    if (group && !group.name) group.name = name;
  }
  const shared = new Map<string, { schema: JsonObject; name: string }>();
  for (const [key, group] of groups) {
    // Tiny primitives are clearer inline and do not materially affect size.
    if (group.count < 2 || key.length < 160) continue;
    const kind =
      group.schema.type ??
      (group.schema.anyOf || group.schema.oneOf ? "Union" : "Schema");
    const name =
      group.name ??
      "Shared" +
        String(kind).replace(/[^A-Za-z0-9]/g, "") +
        "_" +
        createHash("sha256").update(key).digest("hex").slice(0, 16);
    if (!group.name && name in originalComponents)
      throw Error("Shared component name collision: " + name);
    shared.set(key, { schema: group.schema, name });
  }
  const reference = (name: string) => ({
    $ref:
      "#/components/schemas/" +
      name.replaceAll("~", "~0").replaceAll("/", "~1"),
  });
  const visit = (value: any, definition = false): any => {
    if (Array.isArray(value)) return value.map((child) => visit(child));
    if (!value || typeof value !== "object") return value;
    const group = shared.get(keys.get(value)!);
    if (group && !definition) return reference(group.name);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
  };
  const result = visit(document) as T;
  for (const { name, schema } of shared.values())
    result.components.schemas[name] = visit(schema, true);

  // Each generation checks the complete API and every original named schema,
  // so a future serializer change cannot silently discard a validation rule.
  const expanded = resolveSchemaReferences(result);
  expanded.components.schemas = Object.fromEntries(
    Object.keys(originalComponents).map((name) => [
      name,
      expanded.components.schemas[name],
    ]),
  );
  if (!isDeepStrictEqual(document, expanded))
    throw Error("Shared schema expansion changed the published contract");
  return result;
}
