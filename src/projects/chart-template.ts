/**
 * Fixed Helm chart template scaffolded into a project's primary repo under
 * `.yggdrasil/chart/` during project creation (ADR 003 §12) — strict and
 * Yggdrasil-managed, not hand-authored by the project team. The default
 * image is the same placeholder (`nginxdemos/hello`) the Orchestrator's own
 * embedded chart uses until Phase 4's registry/build pipeline exists, so a
 * freshly-scaffolded project still deploys successfully out of the box.
 */
export const CHART_TEMPLATE_FILES: Record<string, string> = {
  "Chart.yaml": `apiVersion: v2
name: primary
description: >-
  Yggdrasil-managed primary deployment chart (ADR 003 §12). Strict template —
  not intended to be hand-edited; Yggdrasil regenerates this during project
  setup.
type: application
version: 0.1.0
appVersion: "1.0"
`,

  "values.yaml": `replicaCount: 1

image:
  repository: nginxdemos/hello
  tag: latest

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
`,

  "templates/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/name: {{ .Release.Name }}
    app.kubernetes.io/managed-by: yggdrasil-orchestrator
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Release.Name }}
      annotations:
        # Forces a rollout when project-env's *content* changes even if
        # nothing else in the chart did — Kubernetes doesn't restart Pods
        # just because a referenced Secret was updated (envFrom is read once
        # at container start).
        checksum/project-env: {{ .Values.secretsChecksum | default "" | quote }}
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - containerPort: 80
          # Name must match k8s.ProjectSecretName (orchestrator internal/k8s/secret.go).
          envFrom:
            - secretRef:
                name: project-env
                optional: true
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
`,

  "templates/service.yaml": `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/name: {{ .Release.Name }}
    app.kubernetes.io/managed-by: yggdrasil-orchestrator
spec:
  selector:
    app.kubernetes.io/name: {{ .Release.Name }}
  ports:
    - port: 80
      targetPort: 80
`,
};
