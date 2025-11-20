# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Immich is a high-performance self-hosted photo and video management solution. The project is a pnpm-based monorepo containing multiple interconnected packages.

## Architecture

### Monorepo Structure

- **server/** - NestJS backend API with three worker types:
  - `api` - Main REST API server (port 2283)
  - `microservices` - Background job processor (BullMQ)
  - `maintenance` - Maintenance mode worker
- **web/** - SvelteKit 2 frontend (static adapter, SSG)
- **mobile/** - Flutter mobile app for iOS and Android
- **machine-learning/** - Python/FastAPI service for ML inference (facial recognition, CLIP search, object detection)
- **cli/** - Node.js CLI tool (`@immich/cli`) for asset upload and management
- **open-api/typescript-sdk/** - Auto-generated TypeScript SDK (`@immich/sdk`) used by web, cli, and e2e
- **e2e/** - End-to-end tests (Vitest for API, Playwright for web)

### Technology Stack

- **Backend**: NestJS, TypeORM/Kysely (PostgreSQL), BullMQ (Redis), Socket.IO
- **Frontend**: SvelteKit 2 (Svelte 5), TailwindCSS 4, Vite
- **Mobile**: Flutter 3.35.7, Dart >=3.8.0, Drift (SQLite), Riverpod
- **ML**: Python 3.10+, FastAPI, ONNX Runtime, InsightFace, Hugging Face
- **Testing**: Vitest (unit), Playwright (e2e web), testcontainers (server medium tests)
- **Package Manager**: pnpm 10.20.0+
- **Node Version**: 24.11.0 (volta)

### Key Architectural Patterns

1. **OpenAPI-First Development**: The server generates `immich-openapi-specs.json`, which is used to generate:
   - TypeScript SDK for web/cli/e2e
   - Dart SDK for mobile (`mobile/openapi/`)

2. **Repository Pattern**: Server uses repository classes (in `server/src/repositories/`) for data access, abstracting database and external services

3. **Service Layer**: Business logic lives in services (`server/src/services/`), which are dependency-injected and use repositories

4. **Queue-Based Processing**: Heavy operations (transcoding, ML inference, thumbnail generation) are processed asynchronously via BullMQ queues

5. **Microservices Architecture**: The server can run in three modes (api/microservices/maintenance) to scale horizontally

6. **Event System**: Server uses an event repository for lifecycle hooks and cross-service communication

## Development Commands

### Workspace-Level Commands

```bash
# Install all dependencies
pnpm install

# Build all packages (order matters due to dependencies)
make build-all

# Run linting across all packages
make lint-all

# Run formatting across all packages
make format-all

# Run type checking across all packages
make check-all

# Run all tests
make test-all
```

### Server (NestJS Backend)

```bash
# Install dependencies (from repo root)
pnpm --filter immich install

# Build
pnpm --filter immich run build

# Run in development mode
cd server && pnpm start:dev

# Run in debug mode (debugger on port 9230)
cd server && pnpm start:debug

# Tests
pnpm --filter immich run test         # Unit tests (vitest)
pnpm --filter immich run test:cov     # With coverage
make test-medium                       # Medium tests (requires docker)
make test-medium-dev                   # Medium tests in dev container

# Code quality
pnpm --filter immich run lint         # ESLint
pnpm --filter immich run lint:fix     # Auto-fix linting
pnpm --filter immich run format       # Check formatting
pnpm --filter immich run format:fix   # Auto-format
pnpm --filter immich run check        # TypeScript check

# Database migrations
pnpm --filter immich run migrations:generate  # Generate from entities
pnpm --filter immich run migrations:run       # Apply migrations
pnpm --filter immich run migrations:revert    # Revert last migration
pnpm --filter immich run schema:reset         # Drop and recreate schema

# Sync OpenAPI spec
pnpm --filter immich run sync:open-api

# Sync SQL type definitions
make sql
```

### Web (SvelteKit Frontend)

```bash
# Install (requires SDK to be built first)
pnpm --filter @immich/sdk run build
pnpm --filter immich-web install

# Build
pnpm --filter immich-web run build

# Development server (port 3000)
cd web && pnpm dev

# Tests
pnpm --filter immich-web run test         # Vitest unit tests
pnpm --filter immich-web run test:cov     # With coverage
pnpm --filter immich-web run test:watch   # Watch mode

# Code quality
pnpm --filter immich-web run lint           # ESLint
pnpm --filter immich-web run lint:fix       # Auto-fix
pnpm --filter immich-web run format         # Check formatting
pnpm --filter immich-web run format:fix     # Auto-format (includes i18n sort)
pnpm --filter immich-web run check:svelte   # Svelte-check
pnpm --filter immich-web run check:typescript  # TypeScript check
```

### Mobile (Flutter)

```bash
cd mobile

# Get dependencies
flutter pub get

# Generate code (routing, serialization, etc.)
flutter pub run build_runner build

# Run on device/emulator
flutter run

# Build
flutter build apk           # Android APK
flutter build ios           # iOS
flutter build appbundle     # Android App Bundle

# Tests
flutter test

# Analyze
flutter analyze
```

### Machine Learning (Python/FastAPI)

```bash
cd machine-learning

# Install dependencies (using uv)
uv sync

# Run development server
uv run uvicorn immich_ml.main:app --reload

# Tests
uv run pytest
uv run pytest --cov

# Code quality
uv run ruff check .         # Linting
uv run black .              # Formatting
uv run mypy .               # Type checking
```

### CLI

```bash
# Install
pnpm --filter @immich/cli install

# Build
pnpm --filter @immich/cli run build

# Run tests
pnpm --filter @immich/cli run test

# Use locally
cd cli && node bin/immich [command]
```

### OpenAPI SDK Generation

```bash
# Generate both TypeScript and Dart SDKs (requires built server)
make open-api

# Generate only TypeScript SDK
make open-api-typescript

# Generate only Dart SDK (for mobile)
make open-api-dart
```

### E2E Tests

```bash
# Run e2e tests (spins up docker compose, runs tests, tears down)
make e2e

# Run in development mode (keeps containers running)
make e2e-dev

# Run Playwright tests (web e2e)
cd e2e && pnpm test:web

# Run with Playwright UI
cd e2e && pnpm start:web
```

### Docker Development

```bash
# Start development environment
make dev

# Stop development environment
make dev-down

# Start with rebuild
make dev-update

# Start with 3 server instances (test horizontal scaling)
make dev-scale
```

## Important Development Notes

### Dependency Order

When building from scratch, dependencies must be built in order:
1. `@immich/sdk` (open-api/typescript-sdk) - required by web, cli, e2e
2. `immich-web` and `@immich/cli` can be built after SDK

Use `make build-all` to handle this automatically.

### Working with OpenAPI

When changing server DTOs or endpoints:
1. Build the server: `pnpm --filter immich build`
2. Generate OpenAPI spec: `pnpm --filter immich run sync:open-api`
3. Regenerate SDKs: `make open-api`
4. Rebuild packages that depend on SDK (web, cli, e2e)

### Database Changes

- The server uses both TypeORM (for migrations) and Kysely (for type-safe queries)
- Migrations are in `server/src/migrations/`
- Always run `sync:sql` after schema changes to update SQL type definitions
- Never commit database credentials

### Testing Strategy

- **Unit tests**: Test individual services/components in isolation (Vitest)
- **Medium tests**: Test service integration with real databases via testcontainers
- **E2E tests**: Test full API flows and web UI interactions
- Run medium tests in docker to ensure consistent environment

### Web Development

- Web uses SvelteKit's static adapter (SSG mode, outputs to `build/`)
- All routes are prerendered, then hydrated client-side
- Internationalization files are in `i18n/` at the repo root
- Web tests use `@testing-library/svelte` and `happy-dom`

### Mobile Development

- Mobile OpenAPI client is auto-generated and should not be manually edited
- Uses Drift for local SQLite database with type-safe queries
- Uses Riverpod for state management
- Custom lint rules in `mobile/immich_lint/`

### Machine Learning

- ML service is separate from main server, communicates via HTTP
- Models are downloaded from Hugging Face on first run
- Supports multiple hardware acceleration backends (CPU, CUDA, OpenVINO, etc.)
- Use `machine-learning/locustfile.py` for load testing

## Code Organization Conventions

### Server

- **controllers/** - API route handlers (thin, delegate to services)
- **services/** - Business logic (testable, use repositories)
- **repositories/** - Data access layer (database, cache, external APIs)
- **dtos/** - Data transfer objects for request/response validation
- **cores/** - Domain entities and core business logic
- **middleware/** - Express/NestJS middleware (auth, logging, error handling)
- **queries/** - Complex SQL queries (used with Kysely)
- **workers/** - BullMQ job processors

### Web

- **src/routes/** - SvelteKit file-based routing
- **src/lib/components/** - Reusable Svelte components
- **src/lib/stores/** - Svelte stores for state management
- **src/lib/utils/** - Utility functions
- **src/lib/api/** - API client wrappers around @immich/sdk

## Main Branch and PRs

- Main branch: `main`
- Create feature branches from `main`
- PRs should target `main`
