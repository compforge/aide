import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environments } from "../connectors/environments.ts";
import { collectWorkloads, observationNamespace } from "../connectors/environments/workloads.ts";
import { workloadChanges } from "../plugins/personal/source/environment/observe.ts";

const meta = (name: string, uid: string, owner?: { kind: string; uid: string }) => ({ name, uid, namespace: "app", generation: 1,
  resourceVersion: "ignored", ownerReferences: owner ? [{ ...owner, controller: true }] : [] });
function fixture() {
  return {
    deployments: [{ metadata: meta("api", "deploy"), spec: { replicas: 1, template: { spec: { containers: [{ name: "api", image: "api:v1", env: [{ name: "TOKEN", value: "must-not-leak" }] }] } } }, status: { readyReplicas: 1 } }],
    statefulsets: [], daemonsets: [],
    replicasets: [{ metadata: meta("not-a-prefix", "rs", { kind: "Deployment", uid: "deploy" }) }],
    pods: [{ metadata: meta("unrelated-name", "pod1", { kind: "ReplicaSet", uid: "rs" }),
      spec: { containers: [{ name: "api", image: "api:v1" }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "api", ready: true, restartCount: 0, imageID: "sha256:1", state: { running: { startedAt: "timestamp" } } }] } }],
  };
}

test("Environment observations use native toolbox HTTP, normalize ownership, and exclude manifest secrets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-kube-"));
  let data = fixture(); let fail = false; let paginate = false;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    if (request.url!.includes("?")) { response.writeHead(403).end(); return; }
    paths.push(request.url!);
    if (fail && request.url!.endsWith("/pods")) { response.writeHead(403).end(); return; }
    const name = request.url!.split("/").at(-1)! as keyof typeof data;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: { continue: paginate ? "more" : "" }, items: data[name] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const kubeconfig = join(root, "kubeconfig");
  writeFileSync(kubeconfig, JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "dev",
    clusters: [{ name: "cluster", cluster: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}` } }],
    contexts: [{ name: "dev", context: { cluster: "cluster", user: "reader" } }], users: [{ name: "reader", user: {} }],
  }));
  const environments = new Environments([{ name: "dev", kind: "kubernetes", kubeconfig, namespace: "app", aliases: ["开发"] }]);
  t.after(async () => {
    await environments.close();
    server.closeAllConnections(); server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const first = await environments.workloads("开发");
  assert.equal(first.environment, "dev"); assert.equal(first.workloads.length, 1);
  assert.equal(first.workloads[0]!.pods[0]!.uid, "pod1");
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|resourceVersion|kubeconfig/);
  assert.equal(paths.length, 5);
  data.deployments[0]!.metadata.resourceVersion = "unrelated-write";
  data.pods[0]!.status.containerStatuses[0]!.state.running.startedAt = "later";
  assert.deepEqual(workloadChanges(first, await environments.workloads("dev")), []);
  data.pods[0]!.metadata.uid = "pod2";
  const replacement = await environments.workloads("dev");
  assert.equal(workloadChanges(first, replacement).length, 1);
  assert.equal(replacement.workloads[0]!.name, "api");
  data.pods[0]!.status.conditions[0]!.status = "False";
  assert.equal(workloadChanges(replacement, await environments.workloads("dev")).length, 1);
  data.pods[0]!.status.containerStatuses[0]!.restartCount++;
  data.pods[0]!.status.containerStatuses[0]!.ready = false;
  assert.equal(workloadChanges(replacement, await environments.workloads("dev")).length, 1);
  fail = true; await assert.rejects(environments.workloads("dev"), /Read Kubernetes resource .*pods/);
  fail = false; paginate = true; await assert.rejects(environments.workloads("dev"), /Incomplete/);
});

test("Missing ownership, malformed and partial lists fail rather than erasing the baseline", async () => {
  const data = fixture(); data.replicasets = [];
  await assert.rejects(collectWorkloads({ async list({ resource }) { return { items: data[resource as keyof typeof data] }; } }, "dev", "app"), /Incomplete controller ownership/);
  await assert.rejects(collectWorkloads({ async list() { return { items: [{}] }; } }, "dev", "app"));
  assert.throws(() => observationNamespace({ name: "dev", kind: "kubernetes", kubeconfig: "unused" }), /explicit namespace/);
  assert.throws(() => observationNamespace({ name: "dev", kind: "host" }, "app"), /not Kubernetes/);
  assert.throws(() => observationNamespace({ name: "dev", kind: "kubernetes", kubeconfig: "unused", host: { name: "vm", transport: "ssh", address: "invalid" } }, "app"), /SSH Host/);
});

test("Replica counts, images, scale-to-zero, additions and removals are workload changes", async () => {
  const data = fixture();
  const read = () => collectWorkloads({ async list({ resource }) { return { items: data[resource as keyof typeof data] }; } }, "dev", "app");
  const baseline = await read();
  data.deployments[0]!.spec.template.spec.containers[0]!.image = "api:v2";
  assert.equal(workloadChanges(baseline, await read()).length, 1);
  data.deployments[0]!.spec.replicas = 0; data.deployments[0]!.status.readyReplicas = 0; data.pods = [];
  const zero = await read(); assert.equal(zero.workloads[0]!.desired, 0); assert.deepEqual(zero.workloads[0]!.pods, []);
  data.deployments = []; data.replicasets = [];
  const empty = await read();
  assert.equal(workloadChanges(zero, empty)[0]!.after, undefined);
  assert.equal(workloadChanges(empty, baseline)[0]!.before, undefined);
});


test("Workload ownership stops at supported carriers even when an operator owns them; list order is irrelevant", async () => {
  const data = fixture();
  data.deployments[0]!.metadata.ownerReferences = [{ kind: "Application", uid: "operator-resource", controller: true }];
  const second = structuredClone(data.pods[0]!); second.metadata.name = "second"; second.metadata.uid = "pod2";
  data.pods.push(second);
  const read = () => collectWorkloads({ async list({ resource }) { return { items: data[resource as keyof typeof data] }; } }, "dev", "app");
  const before = await read();
  assert.equal(before.workloads[0]!.pods.length, 2);
  data.pods.reverse();
  assert.deepEqual(workloadChanges(before, await read()), []);
  Object.assign(data.pods[0]!.status.containerStatuses[0]!, { lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } });
  assert.ok((await read()).workloads[0]!.pods.some((pod) => pod.containers[0]!.lastExitReason === "OOMKilled"));
});

test("Environment queries share Toolbox watches and recover to Kubernetes direct reads on disconnect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-kube-watch-"));
  const data = fixture();
  const watches: ServerResponse[] = [];
  let allowReconnect = true;
  let directReads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    const resource = url.pathname.split("/").at(-1)! as keyof typeof data;
    const expected = resource === "pods" ? "/api/v1" : "/apis/apps/v1";
    if (url.pathname !== `${expected}/namespaces/app/${resource}`) { response.writeHead(404).end(); return; }
    if (url.searchParams.has("watch")) {
      if (!allowReconnect) { response.writeHead(503).end(); return; }
      response.writeHead(200).flushHeaders();
      watches.push(response);
      return;
    }
    if (!url.searchParams.has("limit")) directReads++;
    response.end(JSON.stringify({ metadata: { resourceVersion: "10" }, items: data[resource] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const kubeconfig = join(root, "kubeconfig");
  writeFileSync(kubeconfig, JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "dev",
    clusters: [{ name: "cluster", cluster: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}` } }],
    contexts: [{ name: "dev", context: { cluster: "cluster", user: "reader" } }], users: [{ name: "reader", user: {} }],
  }));
  const environments = new Environments([{ name: "dev", kind: "kubernetes", kubeconfig, aliases: ["开发"] }]);
  t.after(async () => {
    await environments.close();
    server.closeAllConnections(); server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, "Kubernetes client did not switch list paths");
      await delay(10);
    }
  };
  const baseline = await environments.workloads("开发", "app");
  await until(async () => {
    const before = directReads;
    await environments.workloads("dev", "app");
    return watches.length === 5 && directReads === before;
  });
  data.deployments[0]!.spec.template.spec.containers[0]!.image = "api:v2";
  assert.deepEqual(workloadChanges(baseline, await environments.workloads("dev", "app")), []);
  allowReconnect = false;
  for (const watch of watches) watch.end();
  await until(async () => (await environments.workloads("dev", "app")).workloads[0]?.images[0]?.image === "api:v2");
  await environments.close();
  await assert.rejects(environments.workloads("dev", "app"), /closed/);
});
