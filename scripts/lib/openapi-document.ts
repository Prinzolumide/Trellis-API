/**
 * Single source of truth for the OpenAPI document Trellis publishes.
 *
 * `scripts/export-openapi.ts` writes the document to `docs/openapi.json`, and
 * `scripts/check-openapi-drift.ts` builds the very same document in memory to
 * diff it against the committed artefact. Both call `generateOpenApiDocument()`
 * from here, so the published contract and the drift gate can never disagree
 * about how the document is built (document metadata, tags, security schemes and
 * `createDocument` options all live in this file).
 *
 * The document is built exactly the way the published spec always was: the app
 * boots with the TypeORM initialiser mocked so the export works offline, with
 * `deepScanRoutes: true` and `operationIdFactory` returning the raw method name.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/export-openapi.ts
 *   npm run openapi:export
 *
 * Issue: #148
 */

import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DataSource } from "typeorm";

/** Default location of the generated artefact, relative to the repository root. */
export const DEFAULT_OPENAPI_OUTPUT = join(__dirname, "..", "..", "docs", "openapi.json");

/** `SwaggerModule.createDocument` options - part of the published contract. */
export const OPENAPI_DOCUMENT_OPTIONS = {
  deepScanRoutes: true,
  operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
};

/** Document metadata (title, description, servers, security, tags). */
export function buildOpenApiConfig(): Omit<OpenAPIObject, "paths"> {
  return new DocumentBuilder()
    .setTitle("Trellis Backend API")
    .setDescription(
      "Comprehensive API documentation for Trellis backend services including " +
        "agent management, oracle submissions, compute operations, and audit trails.",
    )
    .setVersion("1.0.0")
    .setContact("Trellis Team", "https://trellis.example", "api@trellis.example")
    .setLicense("MIT", "https://opensource.org/licenses/MIT")
    .addServer("http://localhost:3001", "Development Server")
    .addServer("https://api.trellis.example", "Production Server")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT", name: "JWT", description: "Enter JWT token", in: "header" },
      "JWT-auth",
    )
    .addApiKey(
      { type: "apiKey", name: "X-API-Key", in: "header", description: "API key for service-to-service communication" },
      "api-key",
    )
    .addTag("Health", "Liveness, readiness, and startup probes for Kubernetes orchestration")
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Enhanced Authentication & KYC", "Enhanced auth with 2FA and KYC flows")
    .addTag("Users", "User management operations")
    .addTag("Oracle", "Oracle data submissions and payload management")
    .addTag("Price Feed", "Aggregated on-chain price data")
    .addTag("Audit", "Audit trail and logging")
    .addTag("Profile", "User profile management")
    .addTag("Info", "API health and meta-information")
    .build();
}

/**
 * Boots the Nest application, builds the OpenAPI document from the current
 * controller decorators and closes the app again. Nothing is written to disk.
 */
export async function generateOpenApiDocument(): Promise<OpenAPIObject> {
  // Mock TypeORM connection initialization so OpenAPI generation works offline without live Postgres.
  const originalInitialize = DataSource.prototype.initialize;
  DataSource.prototype.initialize = async function () {
    return this;
  };

  // Silence NestJS bootstrap logs - callers only want the document
  let app: any;
  try {
    const { AppModule } = await import("../../src/app.module");
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  } catch (err) {
    console.warn("Bootstrap warning during spec export:", (err as Error).message);
  } finally {
    DataSource.prototype.initialize = originalInitialize;
  }

  if (!app) {
    throw new Error("The Nest application could not be bootstrapped, so no OpenAPI document can be built.");
  }

  try {
    return SwaggerModule.createDocument(app, buildOpenApiConfig(), OPENAPI_DOCUMENT_OPTIONS);
  } finally {
    await app.close();
  }
}

/** Serialises a document exactly the way it is published (2-space JSON). */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return JSON.stringify(document, null, 2);
}

/** Writes a document to disk, defaulting to `docs/openapi.json`. */
export function writeOpenApiDocument(
  document: OpenAPIObject,
  outputPath: string = DEFAULT_OPENAPI_OUTPUT,
): string {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeOpenApiDocument(document), "utf8");
  return outputPath;
}
