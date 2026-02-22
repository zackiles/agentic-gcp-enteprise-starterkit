# RFC AIW001: Reference Architecture - Tools and Patterns for Agentic Automations on GCP with Cloud Run Functions

**Status**: Proposed  
**Owners**: Platform Eng  
**Reviewers**: Infra, Sec, App Teams  
**Decision Date**: TBC (aim for review in 1-2 weeks)  
**Scope**: Canonical, repeatable reference architecture for autonomous agents used across engineering (PR reviews, Jira automation, Slack-triggered actions).

## Background

Enterprise adoption of agentic workflows is facing several challenges, in paritcular, getting momentum on origanizational participation and experimentation needed to move at the same pace as the advancements in AI itself. A next step was recently proposed to tackle these challenges using a reference architecture and its implementation in the form of a "starter kit".

---

## 1) Why this architecture

- Serverless execution, pay-per-use, auto-scale, low ops. Cloud Run functions (the successor name for "Cloud Functions 2nd gen") inherits Cloud Run's scaling and knobs like concurrency. Default concurrency is 80 and can be raised to 1000 per instance. [Cloud Run Concurrency](https://cloud.google.com/run/docs/configuring/concurrency)  
- First-class triggers: HTTP, Pub/Sub, Scheduler. Straightforward IAM. [Triggering Cloud Run / Functions](https://cloud.google.com/run/docs/triggering)  
- Secrets management and short‑lived CI/CD auth via Workload Identity Federation. No static keys. [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)  
- We standardize on Cursor CLI "agents" as the execution engine, invoked from Node.js functions. [Cursor CLI](https://cursor.com/docs/cli)

---

## 2) High‑level design

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

---

## 3) Triggers

- **HTTP**: For Slack slash commands and ad‑hoc calls. Verify Slack signatures; ack within 3s and respond later via `response_url`. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)  
- **Pub/Sub**: Primary work queue. Event payload = agent spec + inputs + `correlation_id`. DLQ enabled with retry policy. 10 MB message max; use GCS for bigger payloads. [Pub/Sub Overview](https://cloud.google.com/pubsub/docs/overview) • [Pub/Sub Quotas (10 MB message)](https://cloud.google.com/pubsub/quotas#resource_limits)  
- **Cloud Scheduler**: Cron to ping HTTP or publish to Pub/Sub for recurring automations. Idempotent targets; native retries. [Cloud Scheduler](https://cloud.google.com/scheduler/docs)

---

## 4) Execution environment (Cloud Run functions)

- Node.js 20 and 22 supported; 2nd gen functions are under the Cloud Run umbrella now ("Cloud Run functions"). [Cloud Run Node.js Runtime](https://cloud.google.com/run/docs/runtime-nodejs)  
- Concurrency and autoscaling are Cloud Run–style. Tune concurrency and max instances per agent type. [Autoscaling](https://cloud.google.com/run/docs/configuring/autoscaling)  
- Secrets via Secret Manager as env or mounted files. Do not store secrets in plain env vars. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- Ephemeral filesystem only; use GCS for persistence; Redis/Firestore for state. [Execution Environment](https://cloud.google.com/run/docs/container-contract)  
- Observability: Cloud Logging, Monitoring, and Error Reporting are integrated. [Cloud Logging](https://cloud.google.com/logging/docs) • [Monitoring](https://cloud.google.com/monitoring/docs) • [Error Reporting](https://cloud.google.com/error-reporting/docs)

---

## 5) Security and IAM

- **Per‑function service accounts** with least‑privilege roles:  
  - Workers: `roles/secretmanager.secretAccessor`, `roles/pubsub.subscriber`, plus write to sink target.  
  - Router: `roles/pubsub.publisher`.  
  - Slack/GitHub call‑ins: restrict ingress and require signed verification (Slack) or IAM. [IAM Roles](https://cloud.google.com/iam/docs/understanding-roles)  
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

// Worker (Pub/Sub trigger)
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
    retryPolicy: "RETRY_POLICY_DO_NOT_RETRY", // rely on sub's retry+DLQ
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
  // Slack HMAC SHA256 verification per https://api.slack.com/authentication/verifying-requests-from-slack
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  // Reject old requests (replay attack prevention)
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
  
  // Slack bots at your company can interface with this function:
  // - Fire-and-forget: Send request, get 202 ack immediately
  // - Wait for response: Worker will post results to response_url
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
  // Slack: immediate ack within 3s; follow-up via response_url by worker
  res.status(202).send({ ok: true, id: msg.correlation_id });
});
```

Slack timing and delayed responses are required; verify with signatures. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)

**Worker (Pub/Sub → Cursor CLI)**

```ts
// functions/worker.ts
import { cloudEvent } from "@google-cloud/functions-framework";
import { spawn } from "child_process";
import { Buffer } from "node:buffer";
import fetch from "node-fetch";

type PubSubEvent = { data?: { message?: { data?: string } } };

function decodeMessage(e: any) {
  try {
    const b64 = e?.data?.message?.data;
    if (!b64) throw new Error("no data");
    const raw = Buffer.from(b64, "base64").toString();
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed Pub/Sub message: ${err}`);
  }
}

async function runCursorAgent(args: string[], env: NodeJS.ProcessEnv) {
  // Cursor CLI invocation per https://cursor.com/docs/cli
  // Typical commands: "cursor agent [strategy]" or "cursor --agent"
  // This wrapper assumes a custom "cursor-agent" binary from @cursor/cli package
  // that supports --name and --input args for remote agent triggering with API key auth.
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn("./node_modules/.bin/cursor-agent", args, { env, shell: true });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

cloudEvent<PubSubEvent>("worker", async (event) => {
  const msg = decodeMessage(event);
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("missing CURSOR_API_KEY");

  const args = [
    "--name", msg.agent?.name ?? "default",
    "--input", JSON.stringify(msg),
  ];

  const { code, stdout, stderr } = await runCursorAgent(args, {
    ...process.env,
    CURSOR_API_KEY: key,
  });

  if (code !== 0) throw new Error(`cursor failed: ${stderr.slice(0, 4000)}`);

  // Optional sinks:
  if (msg.reply?.type?.startsWith("github.")) {
    await postGitHub(msg.reply.targets, stdout);
  }
  if (msg.reply?.type === "slack.message") {
    await fetch(msg.reply.targets.response_url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: stdout.slice(0, 39000) }),
    });
  }
});

async function postGitHub(t: any, body: string) {
  // example: issue comment on PR
  await fetch(`https://api.github.com/repos/${t.repo}/issues/${t.pr}/comments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${t.token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}
```

Cursor CLI usage and Slack delayed responses are standard patterns. References: [Cursor CLI](https://cursor.com/docs/cli) • [Slack response_url](https://api.slack.com/interactivity/handling)

**package.json (agents-mono/functions)**

```json
{
  "name": "agents-mono",
  "private": true,
  "engines": { "node": ">=20" },
  "dependencies": {
    "@google-cloud/functions-framework": "^3.4.0",
    "@google-cloud/pubsub": "^7.7.0",
    "node-fetch": "^3.3.2",
    "@cursor/cli": "^1.0.0"
  },
  "scripts": {
    "start": "functions-framework --target=router",
    "build": "tsc -p tsconfig.json"
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

### A) Automated PR Reviews
- **Trigger**: `pull_request` in GitHub → Action publishes to `agents-main` with agent `pr-reviewer`.  
- **Worker**: Runs Cursor agent, fetches diff with `GITHUB_TOKEN`, posts review comments or a single summary comment. Use the proper REST endpoints. [GitHub REST API](https://docs.github.com/en/rest)  
- **Guardrails**: Max runtime 15–20 min. Concurrency limit to avoid stampeding on big repos. Constrain scopes of GH token.

### B) Jira Ticket Triage / Backlog Grooming
- **Trigger**: Cloud Scheduler cron or Slack command `/triage backlog`.  
- **Worker**: Cursor agent reads repo signals, emits labeled tickets via Jira Cloud REST API using API token auth. [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)  
- **Guardrails**: Dry‑run mode that comments a preview in Slack before creating issues.

### C) Slack‑first Agents
- **Trigger**: Slash command posts to Router HTTP. Ack within 3s, then worker responds on `response_url`. [Slack Interactivity](https://api.slack.com/interactivity/handling)  
- **Security**: Verify Slack signatures; limit IP/ingress if feasible; retries are exponential. [Verify Slack Requests](https://api.slack.com/authentication/verifying-requests-from-slack)

---

## 12) Observability and SLOs

- **Logs**: Structured JSON logs; add `correlation_id` and `agent.name`. [Cloud Logging](https://cloud.google.com/logging/docs)  
- **Metrics/alerts**: Create logs‑based metrics for failures and DLQ counts; alert on spikes. [Monitoring](https://cloud.google.com/monitoring/docs)  
- **Error surfacing**: Error Reporting auto‑ingests exceptions. [Error Reporting](https://cloud.google.com/error-reporting/docs)  
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

- Separate service accounts per function; no cross‑write.  
- Secret Manager only; never commit keys. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- GitHub → GCP uses WIF; no service account keys. [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)  
- Slack/GitHub/Jira tokens scoped and rotated.  
- Optionally use CMEK on Pub/Sub topics. [CMEK](https://cloud.google.com/run/docs/securing/secrets#cmek)

---

## 15) Reference: example sinks

- **GitHub**: Review and comment endpoints for PRs. [GitHub REST API](https://docs.github.com/en/rest)  
- **Jira**: Create issues via REST with API tokens. [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)  
- **Slack**: Respond with `response_url` after ack. [Slack Interactivity](https://api.slack.com/interactivity/handling)

---

## 16) Non‑goals

- No GKE or long‑running services for agents.  
- No persistence in local FS; only `/tmp` is ephemeral. Prefer GCS, Firestore, or Redis. [Execution Environment](https://cloud.google.com/run/docs/container-contract)

---

## 17) Risks and mitigations

- **Agent flakiness**: Use DLQ and redelivery caps; include replay tooling. [DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)  
- **Cost creep**: Enforce max instances; budgets; logs retention controls. [Billing Budgets](https://cloud.google.com/billing/docs/how-to/budgets)  
- **Third‑party API limits**: Implement exponential backoff on outbound calls; Slack/GitHub SDKs include handlers. [Slack Rate Limits](https://api.slack.com/apis/rate-limits) • [GitHub Rate Limits](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)

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

1. Create `poc` project + Pulumi stack.  
2. Deploy `router` and `pr-reviewer` only.  
3. Wire GitHub PR event to publish → observe → comment back.  
4. **A/B testing**: Shadow traffic to new agents (e.g., 5% of PRs) before full rollout to mitigate risks.  
5. Add Slack `/agent` route.  
6. Add Jira triage.  
7. Document runbooks and SLO dashboards.

---

## 20) Open items

- **Redis provider**: Recommend **Memorystore** for GCP-native integration with lower latency and tighter security vs. external providers. [Memorystore for Redis](https://cloud.google.com/memorystore/docs/redis)  
- Confirm per‑agent concurrency and memory defaults via load tests.  
- Decide on standard message schemas per agent family.

---

### Notes and sources

- Cloud Run concurrency and scaling. [Concurrency](https://cloud.google.com/run/docs/configuring/concurrency)  
- Cloud Run functions rebrand (formerly Cloud Functions 2nd gen). [GCP Announcement](https://cloud.google.com/blog/products/serverless/google-cloud-functions-is-now-cloud-run-functions)  
- Pub/Sub triggers, DLQ, and quotas. [Pub/Sub Overview](https://cloud.google.com/pubsub/docs/overview) • [Quotas](https://cloud.google.com/pubsub/quotas) • [DLQ](https://cloud.google.com/pubsub/docs/dead-letter-topics)  
- Secret Manager integrations. [Secret Manager](https://cloud.google.com/secret-manager/docs)  
- Logging/Monitoring/Error Reporting. [Logging](https://cloud.google.com/logging/docs) • [Monitoring](https://cloud.google.com/monitoring/docs) • [Error Reporting](https://cloud.google.com/error-reporting/docs)  
- Cloud Run pricing. [Pricing](https://cloud.google.com/run/pricing)  
- Slack slash command timing and verification. [Slack Verify](https://api.slack.com/authentication/verifying-requests-from-slack) • [Interactivity](https://api.slack.com/interactivity/handling)  
- GitHub APIs. [REST API](https://docs.github.com/en/rest) • [Pull Request Reviews](https://docs.github.com/en/rest/pulls/reviews)  
- Cursor CLI. [Cursor CLI](https://cursor.com/docs/cli)  
- Memorystore for Redis. [Memorystore](https://cloud.google.com/memorystore/docs/redis)
