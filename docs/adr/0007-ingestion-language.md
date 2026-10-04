# 0007 — Reference-data ingestion in TypeScript

- Status: Accepted
- Date: 2026-10-04

## Context

The handover lists Python for ETL, but also requires import jobs that the user can run from inside
the application. A packaged desktop application has no Python runtime.

## Decision

- The ingestion pipeline (source adapters, validation, normalisation, deduplication, import jobs) is
  TypeScript and will live in `@aegis/ingest` from phase 2.
- It shares the Drizzle schema and Zod validators with the application, so the importer and the
  database cannot drift apart.
- The same pipeline runs in the app and from Node on the command line, using the Node transport from
  ADR 0003.
- Python may be used for optional offline analysis. It is never a runtime dependency of the shipped
  application and nothing in the build requires it.

## Consequences

- One toolchain for a single developer.
- In-app import and command-line import are the same code path and are tested once.
