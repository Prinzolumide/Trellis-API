/**
 * Standalone script that boots the NestJS app just long enough to generate
 * and write the OpenAPI JSON document to docs/openapi.json, then exits.
 *
 * The document itself is built by scripts/lib/openapi-document.ts, which is the
 * same code path the drift check (scripts/check-openapi-drift.ts) uses to build
 * the document in memory, so the artefact and the gate can never disagree about
 * how the spec is produced.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/export-openapi.ts
 *   npm run openapi:export
 *
 * Issue: #148
 */

import {
  generateOpenApiDocument,
  writeOpenApiDocument,
} from "./lib/openapi-document";

async function exportOpenApi(): Promise<void> {
  const document = await generateOpenApiDocument();

  // Write JSON
  const jsonPath = writeOpenApiDocument(document);
  console.log(`✅  OpenAPI JSON written to ${jsonPath}`);

  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error("Failed to export OpenAPI spec:", err);
  process.exit(1);
});
