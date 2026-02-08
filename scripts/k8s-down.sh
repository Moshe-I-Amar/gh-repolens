#!/usr/bin/env bash
set -euo pipefail

kubectl delete -f infra/k8s/keda-scaledobjects.yaml --ignore-not-found
kubectl delete -f infra/k8s/web-client.yaml --ignore-not-found
kubectl delete -f infra/k8s/vibe-review-service.yaml --ignore-not-found
kubectl delete -f infra/k8s/repo-fetcher-service.yaml --ignore-not-found
kubectl delete -f infra/k8s/intake-service.yaml --ignore-not-found
kubectl delete -f infra/k8s/rabbitmq.yaml --ignore-not-found
kubectl delete -f infra/k8s/mongodb.yaml --ignore-not-found
kubectl delete -f infra/k8s/configmap.yaml --ignore-not-found
