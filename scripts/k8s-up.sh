#!/usr/bin/env bash
set -euo pipefail

kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/mongodb.yaml
kubectl apply -f infra/k8s/rabbitmq.yaml
kubectl apply -f infra/k8s/intake-service.yaml
kubectl apply -f infra/k8s/repo-fetcher-service.yaml
kubectl apply -f infra/k8s/vibe-review-service.yaml
kubectl apply -f infra/k8s/web-client.yaml
kubectl apply -f infra/k8s/keda-scaledobjects.yaml
