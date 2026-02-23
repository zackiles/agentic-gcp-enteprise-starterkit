# RFC AIW001: Agent-Native Golden Path on GCP Cloud Run Functions

**Status**: Proposed  
**Owners**: Platform Eng  
**Reviewers**: Infra, Sec, App Teams  
**Decision Date**: TBC (aim for review in 1-2 weeks)  
**Scope**: A narrow, opinionated golden path for autonomous agent workloads on GCP Cloud Run Functions. Covers the minimal viable surface—plan, scope, execute, observe—needed to let teams ship agent-native automations (PR reviews, Jira automation, Slack-triggered actions) in days, not quarters.

## Background

Enterprise adoption of agentic workflows is facing several challenges, in particular, getting momentum on organizational participation and experimentation needed to move at the same pace as the advancements in AI itself. A next step was recently proposed to tackle these challenges using a reference architecture and its implementation in the form of a "starter kit".

### Why a distinct path for agents

Traditional microservice and container-based architectures optimize for long-lived processes, complex networking, and fine-grained resource control. These are strengths for stateful transactional systems—and they remain the right choice for those workloads. Autonomous agent workflows, however, have fundamentally different characteristics:

- **Ephemeral by nature**: An agent runs, reasons, acts, and exits. There is no long-lived connection pool or persistent process to manage.
- **Bursty and unpredictable**: A single PR event may spawn one agent; a backlog grooming cron may spawn fifty. The load profile looks nothing like steady-state request traffic.
- **Tool-use over data-path**: Agents call external APIs, read repositories, and post results. They are orchestrators of side-effects, not servers of content.
- **Experimentation velocity is the bottleneck**: The pace of advancement in agentic capabilities—new model releases, emerging tool-use protocols like MCP, evolving prompt engineering patterns—means the architecture must reward fast iteration above all else. A team should go from idea to running agent in a single sprint.

This RFC charts a path that is intentionally distinct from the organization's existing container/microservice architecture. The two worlds are not mutually exclusive. Over time they may converge, coexist as peers, or remain deliberately separate. For now, the priority is to enable AI-native experimentation with the shortest possible lead time from ideation to autonomous execution, while threading the needle on the enterprise concerns—security, compliance, auditability—that are non-negotiable in industries like banking, telecom, and government. We acknowledge those concerns throughout; we do not treat them as afterthoughts. But we refuse to let process overhead become the reason agents never ship.

### Goals of this golden path

1. **Quick plan** — A team identifies an agent use-case and can map it to this architecture in hours, not weeks of design review.
2. **Quick scope and access** — IAM, secrets, and permissions follow a repeatable template. No bespoke infra tickets.
3. **Quick feedback loops** — Fully autonomous execution is the default. Human-in-the-loop review and dry-run modes are escape hatches, not gates.
4. **Quick reporting and explainability** — Every agent invocation is traceable end-to-end via `correlation_id`, structured logs, and observable sinks. Multi-tenant enterprise SaaS organizations get the auditability they need without custom instrumentation.

---

## 1) Why Cloud Run Functions (not containers, not GKE)

Cloud Run Functions are the execution primitive for this golden path. Not Cloud Run services (long-lived containers), not GKE, not Kubernetes operators. The distinction matters:

| Concern | Cloud Run Functions (this path) | Generic container / microservice (traditional) |
|---------|--------------------------------|------------------------------------------------|
| **Unit of deployment** | A single function file | A Dockerfile, image registry, service mesh |
| **Lifecycle** | Event arrives → function executes → exits | Process starts → stays alive → handles N requests |
| **Scaling model** | Per-invocation, auto-scales to zero | Always-on replicas, HPA, node pools |
| **Ops surface** | Near-zero: no Dockerfiles, no ingress controllers, no service mesh | Significant: image builds, registries, networking, health checks |
| **Time to first deploy** | Minutes | Days to weeks (with enterprise governance) |

For agent workloads—ephemeral, bursty, tool-calling—functions are the natural fit. Containers add operational surface area that slows experimentation without adding value for this class of workload.

- **Serverless execution, pay-per-use, auto-scale, low ops.** Cloud Run functions (the successor name for "Cloud Functions 2nd gen") inherits Cloud Run's scaling and knobs like concurrency. For agent workers, we pin concurrency to 1 per instance to guarantee process isolation. [Cloud Run Concurrency](https://cloud.google.com/run/docs/configuring/concurrency)  
- **First-class triggers**: HTTP, Pub/Sub, Scheduler. Straightforward IAM. No API gateways or ingress controllers to configure. [Triggering Cloud Run / Functions](https://cloud.google.com/run/docs/triggering)  
- **Secrets management and short‑lived CI/CD auth** via Workload Identity Federation. No static keys, no Vault clusters to manage. [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)  
- **Headless agent runtime agnostic.** We standardize on Cursor CLI agents as the default execution engine, invoked from Node.js functions. [Cursor CLI](https://cursor.com/docs/cli) The architecture is deliberately runtime-flexible: any headless agent CLI that accepts input over stdio and returns output—Gemini CLI, Claude Code CLI, OpenAI Codex CLI, Goose, or custom model-wrappers—slots into the same function harness. This lets teams swap runtimes as the landscape evolves without re-architecting infrastructure.

---

## 2) High‑level design

The patterns below are intentionally simple. In traditional microservice design, architecture diagrams involve service meshes, API gateways, sidecar proxies, and multi-container pods. Agent-native architecture replaces that complexity with a single concept: **a function that spawns a reasoning process, collects its output, and delivers results**. The infrastructure disappears into the platform.

### Simple pattern: 1:1 agent/function

For most use cases, start with a **single function** that directly handles events:

```
Jira Webhook  →  ┌─────────────────────┐
  or              │  Agent Function     │
Pub/Sub Event  →  │  (Node.js 20/22)    │
  or              │  - verify auth      │
Cloud Scheduler → │  - spawn Cursor CLI │
                  │  - post results     │
                  └─────────────────────┘
                           │
                    Results → Jira/Slack/GitHub
```

**Use this pattern when**: You have a single, well-defined agent (e.g., Jira ticket triage, simple PR analysis) that can handle requests independently. All agent context, tool configs, and prompts live in one function.

### Complex pattern: Router + multiple agents

For workflows with sequential or dependent agents, use a router:

```
            ┌──────────────────────────┐
Slash Cmd → │  HTTP Router Function    │  ← GitHub Webhook / Actions (optional)
            │  (Node.js 20/22)         │
            │  - verify auth           │
            │  - validate payload      │
            │  - publish to Pub/Sub    │
            └──────────┬───────────────┘
                       │ Pub/Sub msg (JSON)
                       ▼
               ┌───────────────┐
               │ Agent Worker  │  (1 per agent type, Node.js)
               │ - spawn Cursor│
               │   CLI process │
               │ - stream/pipe │
               │   outputs     │
               └───────┬───────┘
                       │
            ┌──────────┴──────────┐
            │ Results Sink        │
            │ - GCS (artifacts)   │
            │ - Firestore/Redis   │
            │ - Post back:        │
            │   Slack/GitHub/Jira │
            └─────────────────────┘
```

**Isolation rule**: 1 function = 1 agent. Use a separate "router" function for orchestration and fan‑out/fan‑in. Pub/Sub handles async hops; HTTP used for interactive invocations. Use dead‑letter topics (DLQ) for poison messages. [Pub/Sub DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)

This isolation model maps naturally to agent identity: each function runs under its own service account with scoped permissions. In a multi-tenant enterprise, this gives you per-agent audit trails and blast-radius containment without the ceremony of namespace-per-team Kubernetes topologies.

---

## 3) Triggers

- **HTTP**: For Slack slash commands and ad‑hoc calls. Verify Slack signatures; ack within 3s and respond later via `response_url`. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)  
- **Pub/Sub**: Primary work queue. Event payload = agent spec + inputs + `correlation_id`. DLQ enabled with retry policy. 10 MB message max; use GCS for bigger payloads. [Pub/Sub Overview](https://cloud.google.com/pubsub/docs/overview) • [Pub/Sub Quotas (10 MB message)](https://cloud.google.com/pubsub/quotas#resource_limits)  
- **Cloud Scheduler**: Cron to ping HTTP or publish to Pub/Sub for recurring automations. Idempotent targets; native retries. [Cloud Scheduler](https://cloud.google.com/scheduler/docs)

---

## 4) Execution environment (Cloud Run Functions — not Cloud Run services)

Cloud Run offers two deployment models: **Cloud Run Functions** (event-driven, source-deployed) and **Cloud Run services** (container-image-deployed, long-lived). This golden path uses functions exclusively. The distinction eliminates Dockerfiles, image registries, and container lifecycle management from the developer's workflow. Teams write TypeScript, push to a repo, and the platform handles the rest.

- Node.js 20 and 22 supported; 2nd gen functions are under the Cloud Run umbrella now ("Cloud Run functions"). [Cloud Run Node.js Runtime](https://cloud.google.com/run/docs/runtime-nodejs)  
- **Concurrency pinned to 1 for agent workers.** Unlike traditional Cloud Run services where high concurrency per instance is desirable, agent workers must process one invocation at a time to prevent CLI workspace corruption and ensure deterministic execution. The platform scales horizontally by adding instances, not by packing requests into a single process. [Autoscaling](https://cloud.google.com/run/docs/configuring/autoscaling)  
- Secrets via Secret Manager as env or mounted files. Do not store secrets in plain env vars. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- Ephemeral filesystem only; each invocation gets a sandboxed `/tmp/<correlation_id>` directory. Use GCS for persistence; Redis/Firestore for state. [Execution Environment](https://cloud.google.com/run/docs/container-contract)  
- Observability: Cloud Logging, Monitoring, and Error Reporting are integrated out of the box—no sidecar agents, no collector infrastructure. [Cloud Logging](https://cloud.google.com/logging/docs) • [Monitoring](https://cloud.google.com/monitoring/docs) • [Error Reporting](https://cloud.google.com/error-reporting/docs)

### Workspace model: ephemeral-local, externalized-state

The golden path for agent state is deliberately simple. Each worker invocation assembles a local ephemeral workspace at `/tmp/<correlation_id>`, pulls whatever context it needs from external systems (GitHub repos, Jira tickets, Confluence pages, GCS artifacts), reasons over that context, and emits results back to those same systems and/or publishes follow-up Pub/Sub events. When the function exits, the workspace is gone.

This means **agents do not share state with each other through the filesystem, through in-memory caches, or through any mechanism internal to the function**. All persistent state is externalized into the systems agents already interact with:

- **Source of truth for code context**: Git repositories (cloned into the sandbox or fetched as patches/diffs)
- **Source of truth for task context**: Issue trackers (Jira, GitHub Issues), documentation (Confluence, Notion), Slack threads
- **Artifact storage**: GCS buckets scoped by tenant and correlation_id (see Section 7)
- **Event history**: Pub/Sub messages and Cloud Logging entries, traceable via `correlation_id`

This model is intentionally limited. It handles the majority of single-agent and simple multi-agent workflows without introducing shared databases, distributed caches, or durable execution graphs. Those capabilities are real needs that will emerge as agent workflows grow more sophisticated—but they are not prerequisites for shipping the first wave of production automations.

> **Next step**: A future extension RFC ("Agent State and Storage Patterns") should address advanced state requirements: shared context across multi-step agent chains, durable execution graphs for long-running workflows, Redis/Firestore for conversational agent memory, and cross-agent knowledge bases. The workspace model defined here remains the foundation—externalized state is always the default; internal state is the exception that requires justification.

---

## 5) Security and IAM

Security in agent-native systems is a first-class concern, not a gate that slows delivery. The model below is designed to be adopted in minutes (copy the service account template, set the IAM bindings) while satisfying the core controls that regulated industries require. Formal threat modeling, penetration testing, and compliance certification are assumed to follow as agent workloads mature from experiment to production—but nothing here prevents those activities, and the per-agent isolation model gives auditors clean boundaries to inspect.

- **Per‑function service accounts** (zero-standing-privilege agents) with least‑privilege roles:  
  - Workers: `roles/secretmanager.secretAccessor`, `roles/pubsub.subscriber`, plus write to sink target.  
  - Router: `roles/pubsub.publisher`.  
  - Slack/GitHub call‑ins: restrict ingress and require signed verification (Slack) or IAM. [IAM Roles](https://cloud.google.com/iam/docs/understanding-roles)  
- **Agent tool-use sandboxing**: The `.cursor/cli.json` permissions file shipped with each function denies shell execution by default. Agents operate within a declared tool-use boundary, reducing blast radius and making behavior auditable. This is the agent-native equivalent of a container security policy—but simpler to reason about and enforce.
- **CI/CD**: GitHub Actions → Google Cloud via Workload Identity Federation. No JSON keys. Use `google-github-actions/auth@v2` + `setup-gcloud@v2`. [Auth Action](https://github.com/google-github-actions/auth) • [setup-gcloud](https://github.com/google-github-actions/setup-gcloud)  
- **Secrets**: Cursor API key and third‑party tokens live in Secret Manager; rotate on schedule. [Secret Practices](https://cloud.google.com/secret-manager/docs/best-practices)

---

## 6) Cost posture

- Compute/request pricing follows Cloud Run. You pay for vCPU‑seconds, GiB‑seconds, requests, and egress. [Cloud Run Pricing](https://cloud.google.com/run/pricing)  
- **Free tier**: Cloud Run includes 2M invocations per month, plus generous compute allowances (180K vCPU‑seconds, 360K GiB‑seconds). Most small-to-medium workloads stay within free tier limits.  
- Pub/Sub is throughput‑based (publish + deliver + retention). First 10 GB/month is free. DLQs and retention add storage cost. [Pub/Sub Pricing](https://cloud.google.com/pubsub/pricing)  
- Rule of thumb: 1K one‑minute agent runs at 1 vCPU/1 GiB lands in low single‑digit **USD**; in **CAD** multiply by ~1.4051 (USD→CAD on Nov 4, 2025). Example: USD $5 ≈ CAD $7.03.  
- **Cost controls**: Set up Cloud Billing Budgets with alerts at 50%/90%/100% thresholds to prevent surprise bills. [Billing Budgets](https://cloud.google.com/billing/docs/how-to/budgets)

---

## 7) Message contract (Pub/Sub)

```jsonc
{
  "version": "1.0",
  "correlation_id": "uuid-v4",
  "agent": {
    "name": "pr-reviewer",
    "args": { "repo": "...", "pr": 123 }
  },
  "context": {
    "repo_ref": "org/repo#sha",
    "artifacts": ["gs://bucket/path/..."]
  },
  "reply": {
    "type": "github.pr_review|slack.message|jira.issue",
    "targets": { /* per sink */ }
  },
  "timeouts": { "hard_seconds": 900 }
}
```

Use GCS for payloads > 10 MB. Include `correlation_id` for dedupe and tracing.

---

## 8) Reference Pulumi stack (TypeScript)

> Minimal, composable resources. Omit boilerplate for brevity.

```ts
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

// Note: gcp.cloudfunctionsv2 is correct despite the 2024 rebrand to "Cloud Run functions".
// The API remains unchanged; functions are now managed under the Cloud Run service.
// Reference: https://cloud.google.com/blog/products/serverless/google-cloud-functions-is-now-cloud-run-functions

const region = "us-central1";

// Pub/Sub topics + DLQ
const dlq = new gcp.pubsub.Topic("agents-dlq", { name: "agents-dlq" });
const main = new gcp.pubsub.Topic("agents-main", { name: "agents-main" });

// Subscription w/ DLQ
const sub = new gcp.pubsub.Subscription("agents-sub", {
  topic: main.name,
  deadLetterPolicy: {
    deadLetterTopic: dlq.id,
    maxDeliveryAttempts: 10,
  },
  retryPolicy: { minimumBackoff: "10s", maximumBackoff: "300s" },
});

// Secrets
// Inject secret values via Pulumi config secrets or GitHub Actions environment variables.
// The infrastructure team will finalize the deployment process; this shows the basics.
const cursorSecret = new gcp.secretmanager.Secret("cursor-api-key", {
  replication: { auto: {} },
});
const cursorSecretVersion = new gcp.secretmanager.SecretVersion("cursor-api-key-v1", {
  secret: cursorSecret.id,
  secretData: pulumi.secret("PLACEHOLDER_SET_IN_CI"),
});

// Router function (HTTP)
const routerFn = new gcp.cloudfunctionsv2.Function("router-fn", {
  location: region,
  name: "agents-router",
  buildConfig: {
    runtime: "nodejs22",
    entryPoint: "router",
    // use repo/source integration or storageSource per your pipeline
    source: { repoSource: { repoName: "agents-mono", branchName: "main" } },
  },
  serviceConfig: {
    availableMemory: "1Gi",
    timeoutSeconds: 300,
    environmentVariables: { PUBSUB_TOPIC: main.name },
    serviceAccountEmail: "router-sa@PROJECT.iam.gserviceaccount.com",
    // restrict ingress as needed
  },
});

// Worker (Pub/Sub trigger) — concurrency=1 prevents parallel CLI state corruption
const workerFn = new gcp.cloudfunctionsv2.Function("pr-reviewer-fn", {
  location: region,
  name: "agent-pr-reviewer",
  buildConfig: {
    runtime: "nodejs22",
    entryPoint: "worker",
    source: { repoSource: { repoName: "agents-mono", branchName: "main" } },
  },
  serviceConfig: {
    availableMemory: "2Gi",
    maxInstanceCount: 50,
    maxInstanceRequestConcurrency: 1,
    timeoutSeconds: 1800,
    environmentVariables: {
      CURSOR_API_KEY_SECRET: cursorSecret.id,
    },
    secretEnvironmentVariables: [{
      key: "CURSOR_API_KEY",
      projectId: "PROJECT",
      secret: cursorSecret.name,
      version: "latest",
    }],
    serviceAccountEmail: "worker-sa@PROJECT.iam.gserviceaccount.com",
  },
  eventTrigger: {
    eventType: "google.cloud.pubsub.topic.v1.messagePublished",
    pubsubTopic: main.id,
    triggerRegion: region,
    retryPolicy: "RETRY_POLICY_DO_NOT_RETRY",
  },
});
```

Pulumi resource references: [Pulumi gcp.cloudfunctionsv2.Function](https://www.pulumi.com/registry/packages/gcp/api-docs/cloudfunctionsv2/function/) • [Pulumi Pub/Sub](https://www.pulumi.com/registry/packages/gcp/api-docs/pubsub/)

---

## 9) Runtime code (Node.js 20/22)

**Router (HTTP)**

```ts
// functions/router.ts
import { http } from "@google-cloud/functions-framework";
import { PubSub } from "@google-cloud/pubsub";
import crypto from "crypto";

const topic = process.env.PUBSUB_TOPIC!;
const pubsub = new PubSub();

function verifySlack(req: any): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  const computedSig = `v0=${hmac.update(baseString).digest("hex")}`;

  return crypto.timingSafeEqual(
    Buffer.from(computedSig, "utf8"),
    Buffer.from(signature, "utf8")
  );
}

http("router", async (req, res) => {
  const source = req.headers["user-agent"]?.includes("Slackbot") ? "slack" : "other";

  if (source === "slack" && !verifySlack(req)) return res.status(401).send("bad sig");

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const msg = {
    version: "1.0",
    correlation_id: payload.correlation_id || crypto.randomUUID(),
    agent: payload.agent,
    context: payload.context || {},
    reply: payload.reply || {},
    timeouts: payload.timeouts || { hard_seconds: 900 },
  };

  await pubsub.topic(topic).publishMessage({ json: msg });
  res.status(202).send({ ok: true, id: msg.correlation_id });
});
```

Slack timing and delayed responses are required; verify with signatures. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)

**Worker (Pub/Sub → Cursor CLI)**

> **AIW0001 quick wins applied**: `shell: false` in `spawn()`, binary invoked from `PATH` (not `node_modules/.bin`), per-invocation `/tmp` isolation via `correlation_id`, hard watchdog with process-group kill, and cold-start self-check on module load.

```ts
// functions/worker.ts
import { cloudEvent } from "@google-cloud/functions-framework";
import { spawn, execFileSync } from "child_process";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import fetch from "node-fetch";

const CURSOR_BIN = "cursor-agent";

type PubSubEvent = { data?: { message?: { data?: string } } };

// Cold-start self-check: fail fast if binary is missing
try {
  const version = execFileSync(CURSOR_BIN, ["--version"], {
    timeout: 10_000,
    encoding: "utf8",
  }).trim();
  console.log(`Cold-start check passed: ${CURSOR_BIN} ${version}`);
} catch (err) {
  throw new Error(
    `Cold-start check failed: "${CURSOR_BIN}" is not installed or not on PATH. ` +
      `Ensure the binary is present at build time. Details: ${err}`,
  );
}

function decode(event: any) {
  const b64 = event?.data?.message?.data;
  if (!b64) throw new Error("Malformed Pub/Sub message: missing data field");
  return JSON.parse(Buffer.from(b64, "base64").toString());
}

function runAgent(
  args: string[],
  env: NodeJS.ProcessEnv,
  correlationId: string,
  hardSeconds: number,
) {
  // Per-invocation sandbox: cwd + HOME + XDG dirs scoped to correlation_id
  const sandbox = `/tmp/${correlationId}`;
  mkdirSync(sandbox, { recursive: true });

  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const proc = spawn(CURSOR_BIN, args, {
        cwd: sandbox,
        env: {
          ...env,
          HOME: sandbox,
          XDG_CACHE_HOME: `${sandbox}/.cache`,
          XDG_CONFIG_HOME: `${sandbox}/.config`,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (err += d.toString()));

      // Hard watchdog: kill the entire process group on timeout
      const timer = setTimeout(() => {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        reject(new Error(`cursor-agent exceeded ${hardSeconds}s hard timeout`));
      }, hardSeconds * 1000);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: out, stderr: err });
      });

      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    },
  );
}

async function postGitHub(targets: any, body: string) {
  await fetch(
    `https://api.github.com/repos/${targets.repo}/issues/${targets.pr}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${targets.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
}

cloudEvent<PubSubEvent>("worker", async (event) => {
  const msg = decode(event);
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("missing CURSOR_API_KEY");

  const correlationId = msg.correlation_id || crypto.randomUUID();
  const hardSeconds = msg.timeouts?.hard_seconds ?? 900;

  const args = [
    "--name", msg.agent?.name ?? "default",
    "--input", JSON.stringify(msg),
  ];

  const { code, stdout, stderr } = await runAgent(
    args,
    { ...process.env, CURSOR_API_KEY: key },
    correlationId,
    hardSeconds,
  );

  if (code !== 0) throw new Error(`cursor failed: ${stderr.slice(0, 4000)}`);

  if (msg.reply?.type?.startsWith("github.")) {
    await postGitHub(msg.reply.targets, stdout);
  }
  if (msg.reply?.type === "slack.message") {
    await fetch(msg.reply.targets.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: stdout.slice(0, 39000) }),
    });
  }
});
```

Cursor CLI usage and Slack delayed responses are standard patterns. References: [Cursor CLI](https://cursor.com/docs/cli) • [Slack response_url](https://api.slack.com/interactivity/handling)

**package.json (agents-mono/functions)**

> The `cursor-agent` binary must be available on `PATH` at build time (installed in the container image or vendored into the build output). Do **not** rely on `node_modules/.bin`.

```json
{
  "name": "agents-mono",
  "private": true,
  "engines": { "node": ">=20" },
  "dependencies": {
    "@google-cloud/functions-framework": "^3.4.0",
    "@google-cloud/pubsub": "^7.7.0",
    "node-fetch": "^3.3.2"
  },
  "scripts": {
    "start": "functions-framework --target=router",
    "build": "tsc -p tsconfig.json",
    "check-agent": "cursor-agent --version"
  }
}
```

**Cursor CLI permissions (`.cursor/cli.json`)**

> Ship this file in the function's build output to deny shell execution by default. This reduces blast radius and makes agent behavior deterministic.

```json
{
  "permissions": {
    "shell": {
      "default": "deny",
      "allow": []
    }
  }
}
```

---

## 10) CI/CD

**Workflow**: push → test → Pulumi preview/apply → deploy functions → smoke tests → integration tests.

**GitHub Actions (key excerpts)**

```yaml
name: infra
on:
  push:
    branches: [ main ]
jobs:
  deploy:
    permissions:
      id-token: write
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SA_EMAIL }}
          project_id: ${{ secrets.GCP_PROJECT }}

      - uses: google-github-actions/setup-gcloud@v2

      - uses: pulumi/actions@v4
        with:
          command: up
          stack-name: org/agents/prod
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          # Inject secrets into Secret Manager via Pulumi config or gcloud:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}

      # Optional: publish a test job to agents-main
      - name: smoke-test
        run: |
          echo '{ "agent": {"name":"healthcheck"}, "reply": {"type":"github.pr_review","targets":{"repo":"org/repo","pr":1,"token":"${{secrets.GH_PAT}}"}} }' \
          | gcloud pubsub topics publish agents-main --message=- --project "${{ secrets.GCP_PROJECT }}"
```

WIF + `setup-gcloud` are the supported pattern; avoid long‑lived JSON keys. References: [Auth Action](https://github.com/google-github-actions/auth) • [setup-gcloud](https://github.com/google-github-actions/setup-gcloud)

---

## 11) Use‑case templates

Each template below follows the same golden path: trigger → function → agent → sink. A team can clone any template, swap the agent name and prompt, and have a working automation in a single sprint. The feedback loop from "idea" to "agent posting real results in Slack/GitHub/Jira" should be measured in hours, not sprints.

### A) Automated PR Reviews
- **Trigger**: `pull_request` in GitHub → Action publishes to `agents-main` with agent `pr-reviewer`.  
- **Worker**: Runs Cursor agent, fetches diff with `GITHUB_TOKEN`, posts review comments or a single summary comment. Use the proper REST endpoints. [GitHub REST API](https://docs.github.com/en/rest)  
- **Guardrails**: Max runtime 15–20 min. Concurrency limit to avoid stampeding on big repos. Constrain scopes of GH token.
- **Feedback loop**: Agent posts review → developer responds → agent can re-engage on subsequent push events. Fully autonomous by default; add `"dry_run": true` to the message contract to preview agent output in a Slack DM before it posts to the PR.

### B) Jira Ticket Triage / Backlog Grooming
- **Trigger**: Cloud Scheduler cron or Slack command `/triage backlog`.  
- **Worker**: Cursor agent reads repo signals, emits labeled tickets via Jira Cloud REST API using API token auth. [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)  
- **Guardrails**: Dry‑run mode that comments a preview in Slack before creating issues.
- **Feedback loop**: Agent triages → posts summary to Slack channel → team reviews and adjusts labels → agent learns from corrections on next cron cycle.

### C) Slack‑first Agents
- **Trigger**: Slash command posts to Router HTTP. Ack within 3s, then worker responds on `response_url`. [Slack Interactivity](https://api.slack.com/interactivity/handling)  
- **Security**: Verify Slack signatures; limit IP/ingress if feasible; retries are exponential. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)
- **Human-in-the-loop escape hatch**: For sensitive operations, the agent can post a confirmation prompt with Slack interactive buttons before executing. This gives teams an opt-in approval gate without changing the architecture.

---

## 12) Observability, explainability, and SLOs

In a distributed multi-tenant enterprise, the question is never just "did the agent succeed?" but "what did the agent do, why, and can we prove it?" Cloud Run Functions give us structured observability for free. The patterns below ensure every agent invocation is traceable from trigger to sink without requiring teams to instrument custom telemetry infrastructure.

- **Logs**: Structured JSON logs; add `correlation_id` and `agent.name` to every entry. These two fields are the minimum viable trace for any compliance audit. [Cloud Logging](https://cloud.google.com/logging/docs)  
- **Metrics/alerts**: Create logs‑based metrics for failures and DLQ counts; alert on spikes. [Monitoring](https://cloud.google.com/monitoring/docs)  
- **Error surfacing**: Error Reporting auto‑ingests exceptions. [Error Reporting](https://cloud.google.com/error-reporting/docs)  
- **Agent explainability**: Each agent invocation captures input (message contract), output (sink payload), and execution metadata (duration, exit code, stderr). For regulated environments, persist these artifacts to GCS with retention policies matching your compliance window. When paired with BRAID reasoning traces (see AIW003), this gives full end-to-end explainability of agent decisions.
- **Retention**: Tweak Logging retention to manage cost. [Logging Retention](https://cloud.google.com/logging/docs/retention)  

### Sample SLOs
- **Availability**: 99% of agent invocations complete without function-level errors (5xx)  
- **DLQ rate**: <5% of messages end up in dead-letter queue  
- **Latency**: P95 response time for router <500ms; P95 worker execution time <2 minutes

### Sample Monitoring Query (DLQ Rate)
```
resource.type="cloud_function"
resource.labels.function_name="agent-pr-reviewer"
jsonPayload.message=~"moved to DLQ"
```
Alert when count exceeds threshold over 5-minute window.

---

## 13) Reliability patterns

- **Idempotency**: Deduplicate on `correlation_id`.  
- **Retries**: Prefer subscription retry + DLQ over function auto‑retry to avoid duplicate side‑effects. [Pub/Sub Retry & DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)  
- **Backpressure**: Cap max instances per worker; tune concurrency. [Autoscaling](https://cloud.google.com/run/docs/configuring/autoscaling)  
- **Large inputs**: Store in GCS; pass URI in message. [Cloud Storage](https://cloud.google.com/storage/docs)

---

## 14) Security checklist

The items below represent the minimum viable security posture for agent workloads in a regulated enterprise. They are designed to be adopted on day one without blocking experimentation. Deeper hardening—network policies, VPC-SC perimeters, CMEK encryption, DLP scanning of agent outputs—can be layered in as workloads mature from proof-of-concept to production.

- Separate service accounts per function; no cross‑write.  
- Secret Manager only; never commit keys. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- GitHub → GCP uses WIF; no service account keys. [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)  
- Slack/GitHub/Jira tokens scoped and rotated.  
- Agent tool-use permissions declared in `.cursor/cli.json`; shell execution denied by default.
- Per-invocation filesystem isolation (`/tmp/<correlation_id>`) prevents cross-invocation data leakage.
- Hard process watchdog kills agent processes that exceed `hard_seconds`, preventing resource exhaustion.
- Optionally use CMEK on Pub/Sub topics. [CMEK](https://cloud.google.com/run/docs/securing/secrets#cmek)

---

## 15) Reference: example sinks

- **GitHub**: Review and comment endpoints for PRs. [GitHub REST API](https://docs.github.com/en/rest)  
- **Jira**: Create issues via REST with API tokens. [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)  
- **Slack**: Respond with `response_url` after ack. [Slack Interactivity](https://api.slack.com/interactivity/handling)

---

## 16) Non‑goals (and why)

This section is as important as the goals. The items below are deliberately excluded to keep the golden path narrow and fast. Teams accustomed to traditional microservice architecture may instinctively reach for these patterns—resist that instinct for agent workloads.

- **No GKE, no Kubernetes, no container orchestration.** Agents do not need pod scheduling, service meshes, or node pool management. Cloud Run Functions eliminate this entire layer. If your agent needs GKE, it is likely not an agent—it is a service, and it belongs on a different path.
- **No long‑running services.** Agent functions execute, return, and exit. There is no daemon, no worker pool, no connection draining. The platform handles lifecycle.
- **No custom container images for agent functions.** Source-based deployment (TypeScript → Cloud Run Functions) is the default. Dockerfiles add build complexity and slow iteration cycles. The exception is if an agent runtime requires system-level dependencies not available in the Node.js buildpack—document and justify these cases individually.
- **No persistence in local FS**; only `/tmp` is ephemeral and scoped per invocation. Prefer GCS, Firestore, or Redis. [Execution Environment](https://cloud.google.com/run/docs/container-contract)
- **No comprehensive governance framework up front.** Governance, change-advisory boards, and multi-stage approval pipelines for agent deployments are future concerns. The architecture supports them (Pulumi state, IAM audit logs, `correlation_id` tracing) but does not require them to ship a first agent.

---

## 17) Risks and mitigations

- **Agent flakiness**: Use DLQ and redelivery caps; include replay tooling. Agent non-determinism is an inherent property of LLM-based systems—design for graceful degradation, not perfect reliability. [DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)  
- **Cost creep**: Enforce max instances; budgets; logs retention controls. Agent workloads can be spikier than traditional services—set billing alerts aggressively during experimentation. [Billing Budgets](https://cloud.google.com/billing/docs/how-to/budgets)  
- **Third‑party API limits**: Implement exponential backoff on outbound calls; Slack/GitHub SDKs include handlers. [Slack Rate Limits](https://api.slack.com/apis/rate-limits) • [GitHub Rate Limits](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)
- **Organizational resistance**: Traditional platform and security teams may see agent-native architecture as an end-run around established governance. Address this proactively: the golden path is complementary to existing infrastructure, not a replacement. It uses the same GCP project hierarchy, the same IAM model, the same audit logs. The difference is in the deployment model (functions vs. containers) and the lifecycle (ephemeral vs. long-lived), not in the security posture.
- **Model and runtime churn**: The agentic ecosystem is evolving rapidly—new CLIs, new protocols (MCP, A2A), new model capabilities arrive monthly. The architecture mitigates this by keeping the agent runtime a swappable dependency behind a stable function interface. Swapping from Cursor CLI to another runtime is a one-line change in the worker, not an infrastructure migration.

---

## 18) Appendix: minimal worker that posts a PR comment

```ts
// post back to PR as single summary comment
// POST /repos/{owner}/{repo}/issues/{issue_number}/comments
// https://docs.github.com/en/rest/issues/comments
```

### Optional: Full PR reviews (approvals/change requests)

For more sophisticated review workflows, use the **Reviews API**:  
`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

This allows you to:
- Submit review comments with line-level annotations  
- Approve, request changes, or comment without approval  
- Batch multiple review comments into a single review

Example payload:
```json
{
  "event": "APPROVE",
  "body": "LGTM! Agent-verified code quality.",
  "comments": [
    {
      "path": "src/main.ts",
      "line": 42,
      "body": "Consider refactoring this method."
    }
  ]
}
```

Reference: [GitHub Pull Request Reviews API](https://docs.github.com/en/rest/pulls/reviews)

---

## 19) Rollout plan

The rollout is designed for speed. Each phase should be measurable in days, not weeks. The goal is to get a real agent producing real output in a real environment as fast as possible—then iterate based on observed behavior rather than speculative design.

1. **Day 1–2**: Create `poc` project + Pulumi stack. Deploy `router` and `pr-reviewer` only.  
2. **Day 3–5**: Wire GitHub PR event to publish → observe → comment back. First real agent output visible to the team.
3. **Week 2**: **Shadow mode**: Route a subset of traffic (e.g., 5% of PRs) to the agent. Agent posts results to a review channel, not directly to PRs. Human reviewers compare agent output to their own reviews.
4. **Week 3**: Promote to autonomous mode for non-critical repos. Agent posts directly to PRs. Dry-run mode remains available for sensitive repos.
5. **Week 4+**: Add Slack `/agent` route. Add Jira triage.  
6. Document runbooks and SLO dashboards.
7. Share results internally. The best way to drive organizational adoption is to show a working agent that saved a team real time.

---

## 20) Open items

- **Redis provider**: Recommend **Memorystore** for GCP-native integration with lower latency and tighter security vs. external providers. [Memorystore for Redis](https://cloud.google.com/memorystore/docs/redis)  
- Confirm per‑agent concurrency and memory defaults via load tests.  
- Decide on standard message schemas per agent family.
- **MCP tool-use integration**: As the Model Context Protocol (MCP) matures, evaluate whether agent tool-use declarations should be expressed as MCP server manifests rather than (or in addition to) `.cursor/cli.json`. This could enable cross-runtime tool-use policies.
- **Agent-to-agent communication (A2A)**: For multi-agent workflows that require coordination beyond Pub/Sub fan-out, evaluate emerging agent-to-agent protocols and whether they map cleanly to the Cloud Run Functions model or require a different execution primitive.
- **Compliance automation**: Investigate whether agent invocation logs (correlation_id + input + output + duration) can be automatically fed into existing GRC tooling for continuous compliance reporting.

---

## 21) A note on coexistence

This golden path does not replace the organization's existing microservice and container infrastructure. It runs alongside it, using the same GCP project hierarchy, the same IAM foundations, the same billing accounts. The two worlds serve different purposes:

- **Traditional path**: Stateful services, transactional workloads, long-lived processes, high-throughput data pipelines. Optimized for stability, predictability, and operational maturity.
- **Agent-native path**: Ephemeral reasoning workloads, event-driven automations, tool-calling agents. Optimized for experimentation velocity, rapid iteration, and low operational overhead.

Over time, these paths may converge—agent capabilities may become features within traditional services, or agent orchestration may evolve to require stateful infrastructure. Either outcome is fine. The point of charting a distinct path now is not to create permanent divergence, but to give agent-native experimentation the speed it needs without waiting for traditional infrastructure patterns to adapt. The enterprise controls are present; the audit trails exist; the security model is sound. What changes is the deployment model and the expectation of how fast a team should go from idea to production.

The most likely convergence point is the **router/gateway**. Today the router is a lightweight Cloud Run Function that validates payloads and fans out to Pub/Sub. As agent workflows grow in complexity—dependent execution trees, multi-step chains with shared context, fan-out/fan-in coordination—the router will naturally accumulate orchestration and state management responsibilities. At that point, it becomes a candidate to graduate from a Cloud Run Function into a containerized long-running service on the organization's existing GKE/Cloud Run service infrastructure, while the individual agent workers remain stateless Cloud Run Functions. This is a natural evolution, not a contradiction—the golden path starts simple and grows into the existing platform where the workload demands it.

---

### Notes and sources

- Cloud Run concurrency and scaling. [Concurrency](https://cloud.google.com/run/docs/configuring/concurrency)  
- Cloud Run functions rebrand (formerly Cloud Functions 2nd gen). [GCP Announcement](https://cloud.google.com/blog/products/serverless/google-cloud-functions-is-now-cloud-run-functions)  
- Cloud Run Functions vs. Cloud Run services. [Cloud Run Overview](https://cloud.google.com/run/docs/overview/what-is-cloud-run)
- Pub/Sub triggers, DLQ, and quotas. [Pub/Sub Overview](https://cloud.google.com/pubsub/docs/overview) • [Quotas](https://cloud.google.com/pubsub/quotas) • [DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)  
- Secret Manager integrations. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- Logging/Monitoring/Error Reporting. [Logging](https://cloud.google.com/logging/docs) • [Monitoring](https://cloud.google.com/monitoring/docs) • [Error Reporting](https://cloud.google.com/error-reporting/docs)  
- Cloud Run pricing. [Pricing](https://cloud.google.com/run/pricing)  
- Slack slash command timing and verification. [Slack Verify](https://api.slack.com/authentication/verifying-requests-from-slack) • [Interactivity](https://api.slack.com/interactivity/handling)  
- GitHub APIs. [REST API](https://docs.github.com/en/rest) • [Pull Request Reviews](https://docs.github.com/en/rest/pulls/reviews)  
- Cursor CLI. [Cursor CLI](https://cursor.com/docs/cli)  
- Memorystore for Redis. [Memorystore](https://cloud.google.com/memorystore/docs/redis)
- Model Context Protocol (MCP). [MCP Specification](https://modelcontextprotocol.io/)
- Agent-to-Agent Protocol (A2A). [Google A2A](https://google.github.io/A2A/)
