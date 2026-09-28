#!/usr/bin/env ts-node
/**
 * Fails when the committed OpenAPI artefact (`docs/openapi.json`) is out of sync
 * with the current NestJS controller decorators.
 *
 * The document is built in memory through the exact same code path as
 * `npm run openapi:export` (see scripts/lib/openapi-document.ts) and is never
 * written to disk here, so running the check cannot "fix" the drift it reports.
 * The comparison itself lives in src/common/contract/openapi-drift.ts and is
 * unit tested without booting Nest.
 *
 * Exit codes:
 *   0 - the artefact matches the decorators
 *   1 - drift, or the artefact is missing/empty/unparseable (never a silent pass)
 *   2 - the script was invoked incorrectly
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/check-openapi-drift.ts
 *   npx ts-node -r tsconfig-paths/register scripts/check-openapi-drift.ts --json
 *   npx ts-node -r tsconfig-paths/register scripts/check-openapi-drift.ts --expect path/to/openapi.json
 *
 * Issue: #148
 */

import { resolve } from "path";

import {
  DEFAULT_OPENAPI_ARTIFACT,
  OPENAPI_EXPORT_COMMAND,
  diffOpenApiDocuments,
  formatExpectedArtifactProblem,
  formatOpenApiDriftReport,
  loadExpectedOpenApiDocument,
} from "../src/common/contract/openapi-drift";
import { generateOpenApiDocument } from "./lib/openapi-document";

interface CliOptions {
  artifact: string;
  json: boolean;
  help: boolean;
}

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_USAGE = 2;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    artifact: DEFAULT_OPENAPI_ARTIFACT,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect" || arg === "--artifact") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`"${arg}" expects a file path`);
      }
      options.artifact = value;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Compare the OpenAPI document built from the current controller decorators",
      `with the committed artefact (default: ${DEFAULT_OPENAPI_ARTIFACT}).`,
      "",
      "Options:",
      "  --expect <path>  Artefact to compare against.",
      "  --json           Emit a machine-readable report instead of text.",
      "  --help, -h       Show this help.",
      "",
    ].join("\n"),
  );
}

function reportFailure(options: CliOptions, payload: Record<string, unknown>, text: string): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${text}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return EXIT_OK;
  }

  const artifactPath = resolve(process.cwd(), options.artifact);

  // Load the baseline first: a missing or unusable artefact must fail before we
  // spend time booting the application, and it must never be treated as "no drift".
  const expected = loadExpectedOpenApiDocument(artifactPath);
  if (!expected.ok) {
    reportFailure(
      options,
      {
        check: "openapi-drift",
        ok: false,
        artifact: options.artifact,
        error: expected.error,
        command: OPENAPI_EXPORT_COMMAND,
      },
      formatExpectedArtifactProblem(expected),
    );
    return EXIT_DRIFT;
  }

  let actual: unknown;
  try {
    actual = await generateOpenApiDocument();
  } catch (error) {
    reportFailure(
      options,
      {
        check: "openapi-drift",
        ok: false,
        artifact: options.artifact,
        error: (error as Error).message,
      },
      `Failed to build the OpenAPI document from the current controllers: ${(error as Error).message}`,
    );
    return EXIT_DRIFT;
  }

  const report = diffOpenApiDocuments(expected.document, actual);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { check: "openapi-drift", ok: !report.drifted, artifact: options.artifact, ...report },
        null,
        2,
      )}\n`,
    );
    return report.drifted ? EXIT_DRIFT : EXIT_OK;
  }

  if (report.drifted) {
    process.stderr.write(`${formatOpenApiDriftReport(report, { artifactPath: options.artifact })}\n`);
    return EXIT_DRIFT;
  }

  process.stdout.write(`${formatOpenApiDriftReport(report, { artifactPath: options.artifact })}\n`);
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exit(EXIT_USAGE);
  });
