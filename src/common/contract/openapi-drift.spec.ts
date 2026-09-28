import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEFAULT_OPENAPI_ARTIFACT,
  OPENAPI_EXPORT_COMMAND,
  diffOpenApiDocuments,
  formatExpectedArtifactProblem,
  formatOpenApiDriftReport,
  loadExpectedOpenApiDocument,
  normalizeOpenApiValue,
  stableStringifyOpenApiValue,
} from "./openapi-drift";

type Json = Record<string, any>;

/**
 * Minimal but realistic fixture: two paths, a parameter, a response and one
 * component schema, so every comparison branch can be exercised.
 */
function baseDocument(): Json {
  return {
    openapi: "3.0.0",
    info: { title: "Trellis Backend API", version: "1.0.0" },
    tags: [{ name: "Health" }, { name: "Oracle" }],
    paths: {
      "/api/v1/health": {
        get: {
          summary: "Liveness probe",
          responses: { "200": { description: "Service is healthy" } },
        },
      },
      "/api/v1/import/execute": {
        post: {
          summary: "Execute an atomic import",
          parameters: [
            { name: "dryRun", in: "query", required: false, schema: { type: "boolean" } },
          ],
          responses: { "201": { description: "Committed" } },
        },
      },
    },
    components: {
      schemas: {
        ImportRequestDto: {
          type: "object",
          properties: { entityType: { type: "string" } },
        },
      },
    },
  };
}

/** Mutates a fresh copy of the fixture and returns it. */
function mutated(mutate: (document: Json) => void): Json {
  const document = JSON.parse(JSON.stringify(baseDocument())) as Json;
  mutate(document);
  return document;
}

describe("OpenAPI contract drift comparison", () => {
  let tempDir: string;

  const artifactFile = (name: string, contents: string): string => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-drift-"));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("normalisation", () => {
    it("sorts object keys recursively but preserves meaningful array order", () => {
      const left = {
        b: { d: 1, c: 2 },
        a: [{ z: 1, y: 2 }, { x: 3 }],
      };
      const right = {
        a: [{ y: 2, z: 1 }, { x: 3 }],
        b: { c: 2, d: 1 },
      };

      expect(stableStringifyOpenApiValue(left)).toBe(
        stableStringifyOpenApiValue(right),
      );
      expect(normalizeOpenApiValue(left)).toEqual(right);
    });

    it("does not hide a real ordering change inside an array", () => {
      expect(stableStringifyOpenApiValue({ tags: ["a", "b"] })).not.toBe(
        stableStringifyOpenApiValue({ tags: ["b", "a"] }),
      );
    });
  });

  describe("identical documents", () => {
    it("reports no drift for the same document", () => {
      const report = diffOpenApiDocuments(baseDocument(), baseDocument());

      expect(report.drifted).toBe(false);
      expect(report.differenceCount).toBe(0);
      expect(report.actualOperationCount).toBe(2);
      expect(report.actualPathCount).toBe(2);
    });

    it("reports no drift when only key order and serialisation differ", () => {
      const reordered: Json = {
        components: {
          schemas: {
            ImportRequestDto: {
              properties: { entityType: { type: "string" } },
              type: "object",
            },
          },
        },
        paths: {
          "/api/v1/import/execute": {
            post: {
              responses: { "201": { description: "Committed" } },
              parameters: [
                { schema: { type: "boolean" }, required: false, in: "query", name: "dryRun" },
              ],
              summary: "Execute an atomic import",
            },
          },
          "/api/v1/health": {
            get: {
              responses: { "200": { description: "Service is healthy" } },
              summary: "Liveness probe",
            },
          },
        },
        tags: [{ name: "Health" }, { name: "Oracle" }],
        info: { version: "1.0.0", title: "Trellis Backend API" },
        openapi: "3.0.0",
      };

      expect(diffOpenApiDocuments(baseDocument(), reordered).drifted).toBe(false);
    });
  });

  describe("path drift", () => {
    it("reports a path that the code exposes but the artefact does not", () => {
      const actual = mutated((document) => {
        document.paths["/api/v1/reports"] = {
          get: { summary: "List reports", responses: { "200": { description: "OK" } } },
        };
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.drifted).toBe(true);
      expect(report.addedPaths).toEqual(["/api/v1/reports"]);
      expect(report.removedPaths).toEqual([]);
      // A brand new path is reported once, not once per HTTP method.
      expect(report.addedOperations).toEqual([]);
    });

    it("reports a path the artefact still documents but the code removed", () => {
      const actual = mutated((document) => {
        delete document.paths["/api/v1/import/execute"];
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.drifted).toBe(true);
      expect(report.removedPaths).toEqual(["/api/v1/import/execute"]);
      expect(report.removedOperations).toEqual([]);
      expect(report.actualPathCount).toBe(1);
    });
  });

  describe("operation drift", () => {
    it("reports a method added to an existing path", () => {
      const actual = mutated((document) => {
        document.paths["/api/v1/health"].post = {
          summary: "Create health probe",
          responses: { "201": { description: "Created" } },
        };
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.drifted).toBe(true);
      expect(report.addedOperations).toEqual(["POST /api/v1/health"]);
      expect(report.addedPaths).toEqual([]);
    });

    it("reports a method removed from an existing path", () => {
      const actual = mutated((document) => {
        delete document.paths["/api/v1/health"].get;
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.drifted).toBe(true);
      expect(report.removedOperations).toEqual(["GET /api/v1/health"]);
    });

    it("reports which members of a changed operation drifted", () => {
      const actual = mutated((document) => {
        document.paths["/api/v1/health"].get.summary = "Renamed summary";
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.changedOperations).toEqual([
        { operation: "GET /api/v1/health", members: ["summary"] },
      ]);
    });

    it("reports changed parameters and changed response schemas", () => {
      const actual = mutated((document) => {
        document.paths["/api/v1/import/execute"].post.parameters = [
          { name: "batchId", in: "query", required: true, schema: { type: "string" } },
        ];
        document.paths["/api/v1/import/execute"].post.responses["201"] = {
          description: "Committed",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ImportResultDto" } } },
        };
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.changedOperations).toHaveLength(1);
      expect(report.changedOperations[0].operation).toBe("POST /api/v1/import/execute");
      expect(report.changedOperations[0].members).toEqual(
        expect.arrayContaining(["parameters", "responses"]),
      );
    });

    it("reports changed component schemas separately from operations", () => {
      const actual = mutated((document) => {
        document.components.schemas.ImportRequestDto.properties.rows = {
          type: "array",
          items: { type: "object" },
        };
        document.components.schemas.ImportResultDto = { type: "object" };
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.changedSchemas).toEqual(["ImportRequestDto"]);
      expect(report.addedSchemas).toEqual(["ImportResultDto"]);
      expect(report.changedOperations).toEqual([]);
    });

    it("reports other differing document members such as info and security schemes", () => {
      const actual = mutated((document) => {
        document.info = { title: "Trellis Backend API", version: "1.1.0" };
        document.components.securitySchemes = { "JWT-auth": { type: "http" } };
      });
      const report = diffOpenApiDocuments(baseDocument(), actual);

      expect(report.changedDocumentMembers).toEqual([
        "components.securitySchemes",
        "info",
      ]);
    });
  });

  describe("drift report formatting", () => {
    it("lists the actionable paths, members and the export command to run", () => {
      const actual = mutated((document) => {
        document.paths["/api/v1/reports"] = {
          get: { summary: "List reports", responses: { "200": { description: "OK" } } },
        };
        delete document.paths["/api/v1/import/execute"];
        document.paths["/api/v1/health"].get.summary = "Renamed summary";
      });

      const report = diffOpenApiDocuments(baseDocument(), actual);
      const message = formatOpenApiDriftReport(report, {
        artifactPath: DEFAULT_OPENAPI_ARTIFACT,
      });

      expect(message).toContain("OpenAPI drift detected");
      expect(message).toContain("+ /api/v1/reports");
      expect(message).toContain("- /api/v1/import/execute");
      expect(message).toContain("~ GET /api/v1/health (summary)");
      expect(message).toContain(OPENAPI_EXPORT_COMMAND);
      expect(message).toContain(`git add ${DEFAULT_OPENAPI_ARTIFACT}`);
    });

    it("confirms a clean comparison without printing fix instructions", () => {
      const report = diffOpenApiDocuments(baseDocument(), baseDocument());
      const message = formatOpenApiDriftReport(report, {
        artifactPath: "docs/openapi.json",
      });

      expect(message).toContain("in sync");
      expect(message).toContain("2 operations");
      expect(message).not.toContain(OPENAPI_EXPORT_COMMAND);
    });
  });

  describe("expected artefact loading", () => {
    it("loads a valid artefact", () => {
      const filePath = artifactFile(
        "valid.json",
        JSON.stringify(baseDocument(), null, 2),
      );
      const loaded = loadExpectedOpenApiDocument(filePath);

      expect(loaded.ok).toBe(true);
      expect(loaded.document).toEqual(baseDocument());
    });

    it("fails loudly when the artefact is missing", () => {
      const filePath = path.join(tempDir, "missing.json");
      const loaded = loadExpectedOpenApiDocument(filePath);

      expect(loaded.ok).toBe(false);
      expect(loaded.error).toContain("is missing");

      const message = formatExpectedArtifactProblem(loaded);
      expect(message).toContain(OPENAPI_EXPORT_COMMAND);
      expect(message).toContain(`git add ${DEFAULT_OPENAPI_ARTIFACT}`);
      expect(message).toContain("does not have one");
      expect(message).not.toContain("in sync");
    });

    it("fails loudly when the artefact is empty", () => {
      const loaded = loadExpectedOpenApiDocument(artifactFile("empty.json", "\n  \n"));

      expect(loaded.ok).toBe(false);
      expect(loaded.error).toContain("is empty");
    });

    it("fails loudly when the artefact is not valid JSON", () => {
      const loaded = loadExpectedOpenApiDocument(
        artifactFile("broken.json", "{ not json"),
      );

      expect(loaded.ok).toBe(false);
      expect(loaded.error).toContain("not valid JSON");
    });

    it("fails loudly when the artefact has no paths", () => {
      const loaded = loadExpectedOpenApiDocument(
        artifactFile("nopaths.json", JSON.stringify({ openapi: "3.0.0", info: {} })),
      );

      expect(loaded.ok).toBe(false);
      expect(loaded.error).toContain('no "paths" object');
    });

    it("fails loudly when the artefact declares no operations", () => {
      const loaded = loadExpectedOpenApiDocument(
        artifactFile("emptypaths.json", JSON.stringify({ openapi: "3.0.0", paths: {} })),
      );

      expect(loaded.ok).toBe(false);
      expect(loaded.error).toContain("declares no paths");
    });
  });
});
