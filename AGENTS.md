# Repository Guidelines

## Project Structure & Module Organization

The NestJS API lives in `src/`. Keep authentication code in `src/auth/`, document routes and queue logic in `src/documents/`, storage integration in `src/storage/`, and Prisma access in `src/prisma/`. Request and response DTOs belong in each module's `dtos/` directory. The Python OCR and synthesis worker lives in `ocr_worker/src/docsynth_ocr_worker/`. Database models and SQL migrations are in `prisma/`. Local PostgreSQL, MinIO, and Redis are defined in `docker-compose.yml`.

## Build & Development Commands

Run commands from the repository root. `pnpm install` installs API dependencies. Copy `.env.example` to `.env` and set local secrets before starting services. `pnpm db:up` starts infrastructure; `pnpm db:migrate` applies development migrations. `pnpm start:dev` generates Prisma code and runs the API with reload. Run `uv sync --project ocr_worker` once, then `pnpm ocr:worker` in another terminal. `pnpm build` generates Prisma code and compiles the API; `pnpm lint` runs Oxlint. Use `pnpm db:deploy` to apply existing migrations outside development.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript and four spaces in Python. Follow the existing NestJS pattern: `*.controller.ts` for HTTP routes, `*.service.ts` for logic, and `*.module.ts` for wiring. Use kebab-case filenames and PascalCase DTO classes. Prettier is configured for single quotes and trailing commas; run `pnpm format` for TypeScript formatting. Keep Prisma schema changes paired with a migration.

## Validation

There is currently no automated test suite or `test` script. Validate changed routes manually through the Scalar API reference at `/docs`, and run `pnpm lint` and `pnpm build` before submitting changes. For worker changes, exercise the relevant upload or synthesis flow with the worker running.

## Commits & Pull Requests

Recent commits use short prefixes such as `feat:`, `docs:`, `build:`, and `chore:` followed by an imperative summary. Keep commits focused. In pull requests, describe the behavior changed, list any migration or environment changes, and include manual validation steps or sample API responses when routes change.

## Security & Configuration

Never commit `.env`, credentials, uploaded PDFs, or generated artifacts. Keep `DATABASE_URL`, `S3_*`, and Compose credentials aligned. Authentication and document queries must preserve user ownership checks.
