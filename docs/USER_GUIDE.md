# User Guide (Installation & Usage)

**Who This Guide Is For**
- End users (Web UI): developers who submit GitHub repositories for scanning and review results.
- Developers / Operators: engineers running the services locally or in Kubernetes.

**Prerequisites**
- OS: Any OS that can run Node.js 20+ and Docker (Windows/macOS/Linux). Examples below use PowerShell; use `cp` instead of `copy` on macOS/Linux.
- Node.js: 20+ (Dockerfiles use `node:20-alpine`).
- Package manager: `pnpm` 9+ (root `packageManager` is `pnpm@9.0.0`).
- Docker + Docker Compose: required for the recommended local stack (`infra/docker/docker-compose.yml`).
- MongoDB + RabbitMQ: required. Provided by Docker Compose or your own infrastructure.
- Kubernetes: only if running the `infra/k8s` manifests (uses KEDA for queue-based scaling).

**Installation**
1. Clone the repository.
2. Install dependencies (workspace-aware):
```bash
pnpm install
```
3. Create local env files (edit values as needed):
```bash
copy .env.example .env
copy apps\intake-service\.env.example apps\intake-service\.env
copy apps\repo-fetcher-service\.env.example apps\repo-fetcher-service\.env
copy apps\vibe-review-service\.env.example apps\vibe-review-service\.env
copy apps\web-client\.env.example apps\web-client\.env
```
4. Folder expectations:
- `apps/*` contains services and the web client.
- `packages/*` contains shared libraries.
- `infra/` contains Docker and Kubernetes manifests.

**Environment Configuration**
Environment variables are defined in `.env.example` files and referenced in Docker Compose and K8s manifests.

Root `.env` (shared defaults used by services):
- `MONGODB_URI` (required): MongoDB connection string. Example: `mongodb://mongodb:27017/repolens`.
- `RABBITMQ_URL` (required): RabbitMQ connection string. Example: `amqp://rabbitmq:5672`.
- `WORKSPACES_ROOT` (required): shared directory for repo extraction. Example: `/workspaces`.
- `LOG_LEVEL` (optional): `info`, `debug`, etc.

`apps/intake-service/.env`:
- `PORT` (optional): HTTP port (defaults to `3001` in Compose/K8s).
- `MONGODB_URI` (required).
- `RABBITMQ_URL` (required).
- `LOG_LEVEL` (optional).

`apps/repo-fetcher-service/.env`:
- `MONGODB_URI` (required).
- `RABBITMQ_URL` (required).
- `WORKSPACES_ROOT` (required).
- `LOG_LEVEL` (optional).
- `ZIP_SIZE_LIMIT_MB` (optional): max archive size before aborting (default `200` in Compose/K8s).
- `ZIP_FILE_COUNT_LIMIT` (optional): max number of extracted files (default `50000`).
- `DOWNLOAD_TIMEOUT_MS` (optional): download timeout (default `300000`).
- `EXTRACT_TIMEOUT_MS` (optional): extraction timeout (default `300000`).

`apps/vibe-review-service/.env`:
- `MONGODB_URI` (required).
- `RABBITMQ_URL` (required).
- `WORKSPACES_ROOT` (required).
- `LOG_LEVEL` (optional).
- `REVIEW_TIMEOUT_MS` (optional): review timeout (default `600000`).

`apps/web-client/.env`:
- `VITE_API_BASE_URL` (required): intake API base URL. Example: `http://localhost:3001`.

**Running the System**

Development mode (no Docker)
- Status: Supported but manual. There is no watch mode; services run `node dist/index.js`.
- Requirements: MongoDB + RabbitMQ must be available on `MONGODB_URI` / `RABBITMQ_URL`.
1. Build all packages/services:
```bash
pnpm -r build
```
2. Start each service in separate terminals:
```bash
pnpm --filter @repolens/intake-service dev
pnpm --filter @repolens/repo-fetcher-service dev
pnpm --filter @repolens/vibe-review-service dev
pnpm --filter @repolens/web-client dev
```
3. Expected ports:
- Web client: `http://localhost:5173`
- Intake API: `http://localhost:3001`

Docker Compose mode (recommended local dev)
```bash
pnpm dev:compose
```
Services started:
- `mongodb` (port `27017`)
- `rabbitmq` (ports `5672`, `15672`)
- `intake-service` (port `3001`)
- `repo-fetcher-service`
- `vibe-review-service`
- `web-client` (host port `5174` mapped to container `5173`)

Access:
- Web client: `http://localhost:5174`
- Intake API: `http://localhost:3001`
- RabbitMQ management UI: `http://localhost:15672`

Kubernetes mode (kind/minikube)
- Build and load images:
```bash
docker build -t repolens/intake-service:local -f apps/intake-service/Dockerfile .
docker build -t repolens/repo-fetcher-service:local -f apps/repo-fetcher-service/Dockerfile .
docker build -t repolens/vibe-review-service:local -f apps/vibe-review-service/Dockerfile .
docker build -t repolens/web-client:local -f apps/web-client/Dockerfile .
```
If using kind:
```bash
kind load docker-image repolens/intake-service:local
kind load docker-image repolens/repo-fetcher-service:local
kind load docker-image repolens/vibe-review-service:local
kind load docker-image repolens/web-client:local
```
Apply manifests:
```bash
./scripts/k8s-up.sh
```
Tear down:
```bash
./scripts/k8s-down.sh
```
Expected ports:
- `intake-service` Service port `3001` (expose with `kubectl port-forward` if needed).
- `web-client` Service port `5173` (expose with `kubectl port-forward` if needed).

**Using the System (End User Flow)**
1. Open the Web Client:
- Docker Compose: `http://localhost:5174`
- Local dev: `http://localhost:5173`
2. Submit a GitHub repo URL using the UI form.
3. The job appears in the list with status progression:
`QUEUED → FETCHING → FETCHED → REVIEWING → COMPLETED` (or `FAILED`).
4. Select a completed job to view the review results.
5. The UI polls the intake API; refresh is not required.

**Common Issues & Troubleshooting**
- Services not starting: confirm MongoDB/RabbitMQ are reachable at `MONGODB_URI` / `RABBITMQ_URL`.
- Queue not consuming: verify `repo-fetcher-service` and `vibe-review-service` are running.
- Jobs stuck in `FETCHING`: repo-fetcher worker not running or workspace volume missing.
- Jobs stuck in `REVIEWING`: vibe-review worker not running or review timeout too low.
- GitHub rate limits: no GitHub token configuration exists in this repo. Large or frequent scans may hit rate limits. Missing / Not implemented.
- Missing env vars: ensure all `.env` files exist or use Docker Compose defaults.
- `ZIP_SIZE_LIMIT_EXCEEDED` / `ZIP_FILE_COUNT_LIMIT_EXCEEDED`: adjust limits in repo-fetcher env.

**Notes & Limitations**
- No authentication: all endpoints are unauthenticated.
- Public API: intake endpoints are open by default.
- Scaling assumptions: Compose runs single instances; KEDA manifests scale workers based on RabbitMQ queue length.
- Kubernetes workspace storage: `repo-fetcher-service` and `vibe-review-service` use `emptyDir` for `/workspaces`, so data is ephemeral on pod restart.
- Production hardening (TLS, auth, persistence tuning) is not provided in this repo. Missing / Not implemented.
