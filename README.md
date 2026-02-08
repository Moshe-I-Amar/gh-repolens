# RepoLens

GitHub Repo Scan Platform: Intake -> Fetcher -> Vibe Review -> UI.

## Quick Start (docker-compose)

1) Install dependencies:

```bash
pnpm install
```

2) Start the stack:

```bash
pnpm dev:compose
```

3) Open the UI at `http://localhost:5173` (default Vite port).

## K8s Local (kind/minikube)

1) Build and load images into your cluster:

```bash
docker build -t repolens/intake-service:local -f apps/intake-service/Dockerfile .
docker build -t repolens/repo-fetcher-service:local -f apps/repo-fetcher-service/Dockerfile .
docker build -t repolens/vibe-review-service:local -f apps/vibe-review-service/Dockerfile .
docker build -t repolens/web-client:local -f apps/web-client/Dockerfile .
```

If using kind, load images:

```bash
kind load docker-image repolens/intake-service:local
kind load docker-image repolens/repo-fetcher-service:local
kind load docker-image repolens/vibe-review-service:local
kind load docker-image repolens/web-client:local
```

2) Apply manifests:

```bash
./scripts/k8s-up.sh
```

3) Tear down:

```bash
./scripts/k8s-down.sh
```

4) Verify scaling:

- Install KEDA in the cluster and ensure the `keda-scaledobjects.yaml` applied.
- Submit multiple jobs and observe worker replicas scale with queue length.

## Demo Script

1) Start the stack.
2) Submit 3 GitHub repo URLs in the UI.
3) Confirm jobs move from In Progress to Completed.
4) Open a completed job and expand answers for all 10 questions.
