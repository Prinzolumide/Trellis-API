/**
 * Pure comparison helpers behind `scripts/check-openapi-drift.ts`.
 *
 * The drift gate compares two OpenAPI documents *structurally* rather than
 * textually: both sides are canonicalised (object keys sorted recursively,
 * array order preserved because it is meaningful for `parameters`, `security`
 * and `servers`) and then diffed member by member. Cosmetic noise - key order,
 * indentation, a file re-saved by an editor - therefore never produces a false
 * failure, while a real change to a path, HTTP method, operation, parameter,
 * request body, response or component schema always does.
 *
 * This module deliberately never boots NestJS and only touches the file system
 * to read the expected artefact, which keeps it cheap to unit test (see
 * `openapi-drift.spec.ts`) and safe to import from scripts and specs alike.
 *
 * Issue: #148
 */

import { readFileSync } from "fs";

/** HTTP methods OpenAPI treats as operations on a path item. */
export const OPENAPI_HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type OpenApiHttpMethod = (typeof OPENAPI_HTTP_METHODS)[number];

/** The npm script that regenerates the committed artefact. */
export const OPENAPI_EXPORT_COMMAND = "npm run openapi:export";

/** Repository-relative location of the committed OpenAPI artefact. */
export const DEFAULT_OPENAPI_ARTIFACT = "docs/openapi.json";

/** Top level document members diffed separately from `paths`. */
const HANDLED_TOP_LEVEL_MEMBERS = ["paths", "components"];

export interface OpenApiOperationEntry {
  path: string;
  method: OpenApiHttpMethod;
  operation: Record<string, unknown>;
}

export interface OpenApiOperationChange {
  /** Human readable identifier, e.g. `GET /api/v1/health`. */
  operation: string;
  /** Operation members that differ (`summary`, `parameters`, `responses`, ...). */
  members: string[];
}

export interface OpenApiDriftReport {
  drifted: boolean;
  expectedPathCount: number;
  actualPathCount: number;
  expectedOperationCount: number;
  actualOperationCount: number;
  /** Paths only the live decorators expose (missing from the artefact). */
  addedPaths: string[];
  /** Paths only the artefact still documents (removed from the decorators). */
  removedPaths: string[];
  /** `METHOD /path` pairs only the live decorators expose. */
  addedOperations: string[];
  /** `METHOD /path` pairs only the artefact still documents. */
  removedOperations: string[];
  changedOperations: OpenApiOperationChange[];
  addedSchemas: string[];
  removedSchemas: string[];
  changedSchemas: string[];
  /** Other differing members, e.g. `info`, `servers`, `components.securitySchemes`. */
  changedDocumentMembers: string[];
  differenceCount: number;
}

export interface ExpectedArtifactResult {
  ok: boolean;
  filePath: string;
  document?: Record<string, unknown>;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort(compareStrings);
}

function onlyIn(values: string[], other: string[]): string[] {
  return sortedUnique(values.filter((value) => !other.includes(value)));
}

function inBoth(values: string[], other: string[]): string[] {
  return sortedUnique(values.filter((value) => other.includes(value)));
}

export function isHttpMethod(value: string): value is OpenApiHttpMethod {
  return (OPENAPI_HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Recursively sorts object keys. Array order is intentionally preserved: OpenAPI
 * arrays are ordered (parameters, servers, security, enum values), so only key
 * ordering is treated as cosmetic.
 */
export function normalizeOpenApiValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOpenApiValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareStrings)) {
      normalized[key] = normalizeOpenApiValue((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

/** Canonical, order-insensitive JSON used for every comparison in this module. */
export function stableStringifyOpenApiValue(value: unknown): string {
  const serialized = JSON.stringify(normalizeOpenApiValue(value));
  return serialized === undefined ? "undefined" : serialized;
}

/** Every `paths.<path>.<method>` operation, ordered by path then method. */
export function collectOpenApiOperations(
  document: unknown,
): OpenApiOperationEntry[] {
  const paths = asRecord(asRecord(document).paths);
  const entries: OpenApiOperationEntry[] = [];

  for (const path of Object.keys(paths).sort(compareStrings)) {
    const pathItem = asRecord(paths[path]);
    for (const method of Object.keys(pathItem)) {
      if (!isHttpMethod(method)) {
        continue;
      }
      entries.push({
        path,
        method,
        operation: asRecord(pathItem[method]),
      });
    }
  }

  return entries.sort((left, right) => {
    if (left.path !== right.path) {
      return compareStrings(left.path, right.path);
    }
    return compareStrings(left.method, right.method);
  });
}

/** Serialised `paths` keys of a document. */
export function collectOpenApiPaths(document: unknown): string[] {
  return sortedUnique(Object.keys(asRecord(asRecord(document).paths)));
}

/** `components.schemas` keys of a document. */
export function collectOpenApiSchemas(document: unknown): string[] {
  return sortedUnique(
    Object.keys(asRecord(asRecord(asRecord(document).components).schemas)),
  );
}

function operationMap(
  document: unknown,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of collectOpenApiOperations(document)) {
    map.set(`${entry.method.toUpperCase()} ${entry.path}`, entry.operation);
  }
  return map;
}

function schemaMap(document: unknown): Map<string, unknown> {
  const schemas = asRecord(asRecord(asRecord(document).components).schemas);
  const map = new Map<string, unknown>();
  for (const name of Object.keys(schemas).sort(compareStrings)) {
    map.set(name, schemas[name]);
  }
  return map;
}

function changedMembers(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] {
  return sortedUnique([...Object.keys(expected), ...Object.keys(actual)]).filter(
    (member) =>
      stableStringifyOpenApiValue(expected[member]) !==
      stableStringifyOpenApiValue(actual[member]),
  );
}

function changedDocumentMembers(expected: unknown, actual: unknown): string[] {
  const expectedDocument = asRecord(expected);
  const actualDocument = asRecord(actual);

  const topLevel = sortedUnique([
    ...Object.keys(expectedDocument),
    ...Object.keys(actualDocument),
  ]).filter((member) => !HANDLED_TOP_LEVEL_MEMBERS.includes(member));

  const changed = topLevel.filter(
    (member) =>
      stableStringifyOpenApiValue(expectedDocument[member]) !==
      stableStringifyOpenApiValue(actualDocument[member]),
  );

  const expectedComponents = asRecord(expectedDocument.components);
  const actualComponents = asRecord(actualDocument.components);
  const componentSections = sortedUnique([
    ...Object.keys(expectedComponents),
    ...Object.keys(actualComponents),
  ]).filter((section) => section !== "schemas");

  for (const section of componentSections) {
    if (
      stableStringifyOpenApiValue(expectedComponents[section]) !==
      stableStringifyOpenApiValue(actualComponents[section])
    ) {
      changed.push(`components.${section}`);
    }
  }

  return sortedUnique(changed);
}

/**
 * Diff a committed artefact (`expected`) against the document built from the
 * live controllers (`actual`).
 *
 * Paths that exist on only one side are reported as whole paths; operations are
 * only compared for paths both documents define, so a new path produces one
 * actionable line instead of one line per HTTP method.
 */
export function diffOpenApiDocuments(
  expected: unknown,
  actual: unknown,
): OpenApiDriftReport {
  const expectedPaths = collectOpenApiPaths(expected);
  const actualPaths = collectOpenApiPaths(actual);
  const addedPaths = onlyIn(actualPaths, expectedPaths);
  const removedPaths = onlyIn(expectedPaths, actualPaths);

  const expectedOperations = operationMap(expected);
  const actualOperations = operationMap(actual);

  const addedOperations = onlyIn(
    Array.from(actualOperations.keys()),
    Array.from(expectedOperations.keys()),
  ).filter((key) => {
    const path = key.slice(key.indexOf(" ") + 1);
    return expectedPaths.includes(path);
  });

  const removedOperations = onlyIn(
    Array.from(expectedOperations.keys()),
    Array.from(actualOperations.keys()),
  ).filter((key) => {
    const path = key.slice(key.indexOf(" ") + 1);
    return actualPaths.includes(path);
  });

  const changedOperations: OpenApiOperationChange[] = inBoth(
    Array.from(actualOperations.keys()),
    Array.from(expectedOperations.keys()),
  )
    .map((operation) => ({
      operation,
      members: changedMembers(
        expectedOperations.get(operation) as Record<string, unknown>,
        actualOperations.get(operation) as Record<string, unknown>,
      ),
    }))
    .filter((change) => change.members.length > 0);

  const expectedSchemas = schemaMap(expected);
  const actualSchemas = schemaMap(actual);
  const addedSchemas = onlyIn(
    Array.from(actualSchemas.keys()),
    Array.from(expectedSchemas.keys()),
  );
  const removedSchemas = onlyIn(
    Array.from(expectedSchemas.keys()),
    Array.from(actualSchemas.keys()),
  );
  const changedSchemas = inBoth(
    Array.from(actualSchemas.keys()),
    Array.from(expectedSchemas.keys()),
  ).filter(
    (name) =>
      stableStringifyOpenApiValue(expectedSchemas.get(name)) !==
      stableStringifyOpenApiValue(actualSchemas.get(name)),
  );

  const documentMembers = changedDocumentMembers(expected, actual);

  const differenceCount =
    addedPaths.length +
    removedPaths.length +
    addedOperations.length +
    removedOperations.length +
    changedOperations.length +
    addedSchemas.length +
    removedSchemas.length +
    changedSchemas.length +
    documentMembers.length;

  return {
    drifted: differenceCount > 0,
    expectedPathCount: expectedPaths.length,
    actualPathCount: actualPaths.length,
    expectedOperationCount: expectedOperations.size,
    actualOperationCount: actualOperations.size,
    addedPaths,
    removedPaths,
    addedOperations,
    removedOperations,
    changedOperations,
    addedSchemas,
    removedSchemas,
    changedSchemas,
    changedDocumentMembers: documentMembers,
    differenceCount,
  };
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", `${title}:`, ...lines.map((line) => `  ${line}`)];
}

/** Human readable report, including the exact commands that fix the drift. */
export function formatOpenApiDriftReport(
  report: OpenApiDriftReport,
  options: { artifactPath?: string } = {},
): string {
  const artifactPath = options.artifactPath || DEFAULT_OPENAPI_ARTIFACT;

  if (!report.drifted) {
    return (
      `OpenAPI artefact ${artifactPath} is in sync with the current controller ` +
      `decorators (${report.actualOperationCount} operations across ` +
      `${report.actualPathCount} paths).`
    );
  }

  const lines: string[] = [
    `OpenAPI drift detected: ${artifactPath} does not match the current ` +
      `controller decorators (${report.differenceCount} difference(s); ` +
      `${report.actualOperationCount} operations generated from the code vs ` +
      `${report.expectedOperationCount} committed).`,
  ];

  lines.push(
    ...section(
      "Paths added by the code (regenerate the artefact)",
      report.addedPaths.map((path) => `+ ${path}`),
    ),
  );
  lines.push(
    ...section(
      "Paths removed from the code (regenerate the artefact)",
      report.removedPaths.map((path) => `- ${path}`),
    ),
  );
  lines.push(
    ...section(
      "Operations added by the code",
      report.addedOperations.map((operation) => `+ ${operation}`),
    ),
  );
  lines.push(
    ...section(
      "Operations removed from the code",
      report.removedOperations.map((operation) => `- ${operation}`),
    ),
  );
  lines.push(
    ...section(
      "Operations whose definition changed",
      report.changedOperations.map(
        (change) => `~ ${change.operation} (${change.members.join(", ")})`,
      ),
    ),
  );
  lines.push(
    ...section(
      "Component schemas added by the code",
      report.addedSchemas.map((name) => `+ ${name}`),
    ),
  );
  lines.push(
    ...section(
      "Component schemas removed from the code",
      report.removedSchemas.map((name) => `- ${name}`),
    ),
  );
  lines.push(
    ...section(
      "Component schemas whose definition changed",
      report.changedSchemas.map((name) => `~ ${name}`),
    ),
  );
  lines.push(
    ...section(
      "Other document members that changed",
      report.changedDocumentMembers.map((member) => `~ ${member}`),
    ),
  );

  lines.push(
    "",
    "Fix: regenerate the artefact from the current decorators and commit it.",
    `  1. ${OPENAPI_EXPORT_COMMAND}`,
    `  2. git add ${artifactPath}`,
    '  3. git commit -m "docs: re-export OpenAPI spec"',
  );

  return lines.join("\n");
}

/**
 * Loads the committed artefact. A missing, unreadable, empty, malformed or
 * path-less file is reported as a failure with an explanation, never as "no
 * drift": deleting the artefact must not be a way to satisfy the gate.
 */
export function loadExpectedOpenApiDocument(
  filePath: string,
): ExpectedArtifactResult {
  let raw: string;

  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    const error_ =
      code === "ENOENT"
        ? `${filePath} is missing.`
        : `${filePath} could not be read: ${(error as Error).message}`;
    return { ok: false, filePath, error: error_ };
  }

  if (raw.trim().length === 0) {
    return { ok: false, filePath, error: `${filePath} is empty (0 bytes).` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      filePath,
      error: `${filePath} is not valid JSON: ${(error as Error).message}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      filePath,
      error: `${filePath} is not an OpenAPI document (expected a JSON object).`,
    };
  }

  const document = parsed as Record<string, unknown>;
  if (typeof document.paths !== "object" || document.paths === null) {
    return {
      ok: false,
      filePath,
      error: `${filePath} is not an OpenAPI document (no "paths" object).`,
    };
  }

  if (collectOpenApiPaths(document).length === 0) {
    return {
      ok: false,
      filePath,
      error: `${filePath} declares no paths, so it cannot act as a drift baseline.`,
    };
  }

  return { ok: true, filePath, document };
}

/** Loud, actionable message for an unusable expected artefact. */
export function formatExpectedArtifactProblem(
  result: ExpectedArtifactResult,
): string {
  if (result.ok) {
    return `${result.filePath} is a usable OpenAPI artefact.`;
  }

  return [
    `Cannot check OpenAPI drift: ${result.error}`,
    "",
    "This check diffs the OpenAPI document built from the live controller",
    "decorators against the committed artefact, so it cannot pass without one.",
    "",
    "Fix: generate the artefact from the current decorators and commit it.",
    `  1. ${OPENAPI_EXPORT_COMMAND}`,
    `  2. git add ${DEFAULT_OPENAPI_ARTIFACT}`,
    '  3. git commit -m "docs: re-export OpenAPI spec"',
    "",
    `If git ignores ${DEFAULT_OPENAPI_ARTIFACT}, remove that entry from .gitignore.`,
  ].join("\n");
}
