import * as k8s from "@kubernetes/client-node";

/**
 * ADR 016 item 11-13: lightweight reachability check for an org's kubeconfig.
 * Lists namespaces (limit 1) — cheap, read-only, and exercises both the
 * cluster's reachability and the credentials' authorization.
 */
export async function testClusterConnection(kubeconfig: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const config = new k8s.KubeConfig();
    config.loadFromString(kubeconfig);
    const api = config.makeApiClient(k8s.CoreV1Api);
    await api.listNamespace({ limit: 1 });
    return { ok: true };
  } catch (error) {
    if (error instanceof k8s.ApiException) {
      if (error.code === 401 || error.code === 403) {
        return { ok: false, error: "The cluster rejected these credentials" };
      }
      return { ok: false, error: `Cluster responded with ${error.code}` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}
