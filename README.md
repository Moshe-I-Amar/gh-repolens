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

1) Build and load images (see `infra/k8s/README.md` once added).
2) Apply manifests:

```bash
./scripts/k8s-up.sh
```

3) Tear down:

```bash
./scripts/k8s-down.sh
```

## Demo Script

1) Start the stack.
2) Submit 3 GitHub repo URLs in the UI.
3) Confirm jobs move from In Progress to Completed.
4) Open a completed job and expand answers for all 10 questions.
