# RFC AIW002: Local Build, Test, Deploy Workflows for Rapid Iteration of Agents and Agent-driven Self-improvement

**Status**: Proposed  
**Owners**: Platform Eng  
**Reviewers**: Infra, Sec, App Teams  
**Decision Date**: TBC (aim for review in 1-2 weeks)  
**Scope**: Extends AIW001 with practical local development workflow enabling rapid iteration of GCP Cloud Run functions before production deployment. Focuses on clickops-to-production workflow with emphasis on local testing patterns.

---

## 1) Context and Motivation

AIW001 established the reference architecture for agentic automations on GCP. This RFC addresses the **development workflow gap**: teams need to iterate quickly on agent functions locally before deploying to staging or production. Without efficient local testing, developers face slow feedback cycles, increased approval friction, and higher risk of breaking production.

**Goals**:
- Enable developers to clone the reference architecture repo and have a working local environment in **under 10 minutes**
- Provide secure, simple local testing of GCP functions that mirrors production behavior
- Support rapid iteration cycles (test → iterate → test) without cloud deployments
- Establish a clear path from clickops to productionized Pulumi deployments
- Minimize external dependencies and approval requirements for early development

**Non-goals**:
- Long-term production scale concerns
- Multi-region deployment strategies
- Advanced observability beyond basic telemetry
- Production-grade security hardening (that comes later)

---

## 2) Technology Choices: TypeScript/JavaScript for Serverless Functions and AI Integrations

**Decision**: Standardize on TypeScript/JavaScript (Node.js 20/22) for all agent functions, even though some teams use Go.

**Rationale**:
- **AI/LLM ecosystem**: The JavaScript/TypeScript ecosystem has the strongest tooling and SDK support for AI integrations. Cursor CLI, OpenAI SDKs, and most agent frameworks are JavaScript-first with excellent TypeScript support.
- **Rapid iteration**: JavaScript's interpreted nature and hot-reload capabilities enable faster development cycles. TypeScript provides type safety without the compilation overhead of Go for serverless functions.
- **Serverless optimization**: Cloud Run functions support Node.js with minimal cold start overhead. While Go can have smaller binaries, the difference is negligible for agent functions that typically run for minutes, not milliseconds.
- **Developer experience**: Most teams already have Node.js tooling configured. TypeScript's type system catches errors early without the compile-time friction of Go for exploratory agent development.
- **Integration simplicity**: Third-party APIs (Slack, GitHub, Jira) have mature Node.js SDKs with better documentation and community support than Go equivalents.
- **Cursor CLI compatibility**: Cursor CLI is designed to work seamlessly with JavaScript/TypeScript codebases, making agent invocation and tooling integration more straightforward.

**Exception**: If a team has specific Go expertise and the agent logic is purely computational (not AI-integrated), Go remains acceptable. However, the reference architecture and tooling assume TypeScript/JavaScript.

---

## 3) Quick Start: Clone and Configure in Minutes

### 3.1 Prerequisites Check

Developers should have:
- macOS with Homebrew (or equivalent package manager)
- Node.js 20+ installed (`node --version`)
- GCP CLI installed and authenticated (`gcloud --version`)
- Access to create a GCP project (or use existing dev project)
- API keys for Cursor, GitHub (if needed), and other services

**Quick setup script**:
```bash
# Verify prerequisites
command -v node >/dev/null 2>&1 || { echo "Install Node.js 20+"; exit 1; }
command -v gcloud >/dev/null 2>&1 || { brew install google-cloud-sdk; }
gcloud auth application-default login  # One-time setup
```

### 3.2 Clone and Initialize

```bash
# Clone the reference architecture repo
git clone https://github.com/org/agents-reference-architecture.git
cd agents-reference-architecture

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Interactive setup (creates .env with local values)
npm run setup:local
```

The `setup:local` script prompts for:
- GCP project ID (or creates a new dev project)
- Cursor API key (stored locally, not committed)
- Optional: GitHub token, Slack signing secret (for testing integrations)
- Local port preferences (default: 8080 for functions, 8085 for Pub/Sub emulator)

### 3.3 Environment Configuration

**`.env` (local, gitignored)**:
```bash
# GCP Configuration
GCP_PROJECT_ID=dev-yourname-12345
GCP_REGION=us-central1

# Local Development
FUNCTIONS_PORT=8080
PUBSUB_EMULATOR_PORT=8085
USE_EMULATOR=true

# API Keys (local only, not committed)
CURSOR_API_KEY=your-key-here
GITHUB_TOKEN=your-token-here
SLACK_SIGNING_SECRET=your-secret-here

# Function Configuration
NODE_ENV=development
LOG_LEVEL=debug
```

**`.env.example` (committed, template only)**:
```bash
# GCP Configuration
GCP_PROJECT_ID=
GCP_REGION=us-central1

# Local Development
FUNCTIONS_PORT=8080
PUBSUB_EMULATOR_PORT=8085
USE_EMULATOR=true

# API Keys (set in .env, never commit)
CURSOR_API_KEY=
GITHUB_TOKEN=
SLACK_SIGNING_SECRET=
```

---

## 4) Local Testing Architecture

### 4.1 Core Components

Local testing uses **GCP-native emulators** and the **Functions Framework** to mirror production behavior:

```
┌─────────────────────────────────────────────────────────┐
│  Local Development Environment                          │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                 │
│  │  Functions   │    │  Pub/Sub     │                 │
│  │  Framework   │◄───│  Emulator    │                 │
│  │  (localhost) │    │  (localhost) │                 │
│  └──────┬───────┘    └──────┬───────┘                 │
│         │                   │                          │
│         │  ┌────────────────┴────────┐                │
│         │  │  Local Secrets          │                │
│         │  │  (.env file)            │                │
│         │  └─────────────────────────┘                │
│         │                                              │
│         ▼                                              │
│  ┌──────────────────────────────────────┐            │
│  │  Cursor CLI (spawned locally)        │            │
│  │  - Uses real API key                 │            │
│  │  - Runs actual agent logic           │            │
│  └──────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Functions Framework for Local Testing

The **Google Cloud Functions Framework** (`@google-cloud/functions-framework`) is the official tool for running Cloud Run functions locally. It emulates the production runtime environment.

**Installation**:
```bash
npm install --save-dev @google-cloud/functions-framework
```

**Usage**:
```bash
# Run a single function locally
npx functions-framework --target=router --port=8080

# Or via npm script
npm run dev:router
```

**package.json scripts**:
```json
{
  "scripts": {
    "dev:router": "functions-framework --target=router --port=8080 --source=dist",
    "dev:worker": "functions-framework --target=worker --port=8081 --source=dist",
    "dev:all": "concurrently \"npm run dev:router\" \"npm run dev:worker\"",
    "build": "tsc",
    "watch": "tsc --watch",
    "test:local": "npm run build && npm run dev:all"
  }
}
```

### 4.3 Pub/Sub Emulator

The **Pub/Sub Emulator** provides a local implementation of Google Cloud Pub/Sub that runs on your machine. It's essential for testing Pub/Sub-triggered functions locally.

**Installation**:
```bash
gcloud components install pubsub-emulator
```

**Starting the emulator**:
```bash
# Start emulator (runs on port 8085 by default)
gcloud beta emulators pubsub start --project=dev-local --host-port=localhost:8085
```

**Connecting functions to the emulator**:
```typescript
// src/config/pubsub.ts
import { PubSub } from "@google-cloud/pubsub";

const useEmulator = process.env.USE_EMULATOR === "true";
const emulatorHost = process.env.PUBSUB_EMULATOR_HOST || "localhost:8085";

if (useEmulator) {
  process.env.PUBSUB_EMULATOR_HOST = emulatorHost;
  console.log(`[LOCAL] Using Pub/Sub emulator at ${emulatorHost}`);
}

export const pubsub = new PubSub({
  projectId: process.env.GCP_PROJECT_ID || "dev-local",
});
```

**Helper script** (`scripts/start-emulators.sh`):
```bash
#!/bin/bash
set -e

echo "Starting Pub/Sub emulator..."
gcloud beta emulators pubsub start \
  --project=${GCP_PROJECT_ID:-dev-local} \
  --host-port=localhost:${PUBSUB_EMULATOR_PORT:-8085} \
  &
PUBSUB_PID=$!

echo "Pub/Sub emulator started (PID: $PUBSUB_PID)"
echo "To stop: kill $PUBSUB_PID"

# Wait for emulator to be ready
sleep 3

# Set environment variable for Node.js processes
export PUBSUB_EMULATOR_HOST=localhost:${PUBSUB_EMULATOR_PORT:-8085}

# Run functions
npm run dev:all

# Cleanup on exit
trap "kill $PUBSUB_PID" EXIT
```

### 4.4 Secrets Management (Local)

For local development, secrets are stored in `.env` and loaded via `dotenv`. **Never commit `.env` to git**.

**Secret loading pattern**:
```typescript
// src/config/secrets.ts
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

export const secrets = {
  cursorApiKey: process.env.CURSOR_API_KEY!,
  githubToken: process.env.GITHUB_TOKEN,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
};

// Validate required secrets
if (!secrets.cursorApiKey) {
  throw new Error("CURSOR_API_KEY is required");
}
```

**Security note**: In production, secrets come from Secret Manager. The local `.env` file is gitignored and only used for development.

---

## 5) Local Testing Workflow

### 5.1 Testing HTTP Functions (Router)

**Start the function**:
```bash
npm run dev:router
```

**Test with curl**:
```bash
# Test Slack webhook (with signature verification disabled in dev mode)
curl -X POST http://localhost:8080/router \
  -H "Content-Type: application/json" \
  -d '{
    "agent": {"name": "test-agent"},
    "context": {"test": true},
    "reply": {"type": "slack.message"}
  }'
```

**Test with HTTP client** (Postman/Insomnia or `src/scripts/test-router.ts`):
```typescript
// src/scripts/test-router.ts
import fetch from "node-fetch";

async function testRouter() {
  const response = await fetch("http://localhost:8080/router", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: { name: "test-agent" },
      context: { test: true },
      reply: { type: "slack.message" },
    }),
  });

  const result = await response.json();
  console.log("Router response:", result);
}

testRouter().catch(console.error);
```

### 5.2 Testing Pub/Sub Functions (Worker)

**Start Pub/Sub emulator and worker**:
```bash
# Terminal 1: Start emulator
gcloud beta emulators pubsub start --project=dev-local --host-port=localhost:8085

# Terminal 2: Start worker function
PUBSUB_EMULATOR_HOST=localhost:8085 npm run dev:worker
```

**Publish a test message**:
```bash
# Using gcloud (pointed at emulator)
PUBSUB_EMULATOR_HOST=localhost:8085 \
gcloud pubsub topics publish test-topic \
  --message='{"agent":{"name":"test-agent"},"context":{}}' \
  --project=dev-local
```

**Or use a test script**:
```typescript
// src/scripts/test-worker.ts
import { PubSub } from "@google-cloud/pubsub";

async function testWorker() {
  process.env.PUBSUB_EMULATOR_HOST = "localhost:8085";
  const pubsub = new PubSub({ projectId: "dev-local" });
  
  const topic = pubsub.topic("agents-main");
  await topic.publishMessage({
    json: {
      version: "1.0",
      correlation_id: crypto.randomUUID(),
      agent: { name: "test-agent" },
      context: {},
      reply: { type: "slack.message" },
    },
  });
  
  console.log("Message published to emulator");
}

testWorker().catch(console.error);
```

### 5.3 End-to-End Local Testing

**Complete workflow test**:
```typescript
// src/scripts/test-e2e.ts
import fetch from "node-fetch";
import { PubSub } from "@google-cloud/pubsub";

async function testE2E() {
  // 1. Send HTTP request to router
  const routerResponse = await fetch("http://localhost:8080/router", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: { name: "pr-reviewer", args: { repo: "test/repo", pr: 123 } },
      context: { repo_ref: "test/repo#main" },
      reply: { type: "github.pr_review", targets: { repo: "test/repo", pr: 123 } },
    }),
  });

  const { id } = await routerResponse.json();
  console.log(`Router acknowledged request: ${id}`);

  // 2. Wait for worker to process (in real scenario, worker subscribes to topic)
  // For testing, we can manually trigger worker processing
  console.log("Worker should process message from Pub/Sub...");
}

testE2E().catch(console.error);
```

---

## 6) Development Workflow: Rapid Iteration Cycle

### 6.1 Typical Development Session

1. **Start local environment**:
   ```bash
   npm run dev:all  # Starts emulators + functions
   ```

2. **Make code changes** (TypeScript files in `src/`):
   ```bash
   npm run watch  # Recompiles on save
   ```

3. **Test locally**:
   ```bash
   npm run test:local  # Runs test scripts
   # Or manually trigger via curl/scripts
   ```

4. **Iterate**: Make changes, test, repeat. No cloud deployment needed.

5. **When ready for cloud testing**:
   ```bash
   # Deploy to dev project (clickops initially, Pulumi later)
   gcloud functions deploy router-fn --gen2 --runtime=nodejs22 ...
   ```

### 6.2 Hot Reload Pattern

For faster iteration, use a file watcher that restarts the Functions Framework on changes:

```json
{
  "scripts": {
    "dev:router:watch": "nodemon --watch dist --exec 'functions-framework --target=router --port=8080 --source=dist'"
  }
}
```

**Note**: The Functions Framework doesn't support true hot reload. The pattern above restarts the function on file changes, which is acceptable for rapid iteration.

### 6.3 Debugging

**VS Code launch configuration** (`.vscode/launch.json`):
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Router Function",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["functions-framework", "--target=router", "--port=8080", "--source=dist"],
      "sourceMaps": true,
      "preLaunchTask": "build",
      "env": {
        "NODE_ENV": "development",
        "USE_EMULATOR": "true",
        "PUBSUB_EMULATOR_HOST": "localhost:8085"
      }
    }
  ]
}
```

**Debugging Pub/Sub triggers**: Set breakpoints in the worker function and manually publish messages to the emulator to trigger execution.

---

## 7) Clickops to Production Path

### 7.1 Phase 1: Clickops (Initial Setup)

**Goal**: Get a working agent deployed quickly with minimal infrastructure code.

**Steps**:
1. Create GCP project via Console (or `gcloud projects create`)
2. Enable required APIs:
   ```bash
   gcloud services enable cloudfunctions.googleapis.com
   gcloud services enable pubsub.googleapis.com
   gcloud services enable secretmanager.googleapis.com
   ```
3. Create Pub/Sub topic/subscription via Console
4. Create secrets in Secret Manager via Console
5. Deploy function via Console or `gcloud`:
   ```bash
   gcloud functions deploy router-fn \
     --gen2 \
     --runtime=nodejs22 \
     --region=us-central1 \
     --source=. \
     --entry-point=router \
     --trigger-http \
     --allow-unauthenticated
   ```

**Why clickops first**: 
- Faster initial setup (no Pulumi learning curve)
- Visual validation of resources
- Easier to understand what's being created
- Can transition to Pulumi incrementally

### 7.2 Phase 2: Hybrid (Clickops + Pulumi)

**Goal**: Codify infrastructure while maintaining flexibility for experimentation.

**Approach**: Use Pulumi for core resources (Pub/Sub, secrets structure), but allow manual function deployments during development.

**Pulumi stack** (`infra/dev/Pulumi.dev.yaml`):
```typescript
import * as gcp from "@pulumi/gcp";

const project = "dev-yourname-12345";
const region = "us-central1";

// Core infrastructure (always via Pulumi)
const topic = new gcp.pubsub.Topic("agents-main", {
  project,
  name: "agents-main",
});

const secret = new gcp.secretmanager.Secret("cursor-api-key", {
  project,
  replication: { auto: {} },
});

// Functions deployed manually during dev (clickops)
// Pulumi will manage these in Phase 3
```

**Workflow**:
- Infrastructure (topics, secrets) managed by Pulumi
- Functions deployed manually for rapid iteration
- When function structure stabilizes, migrate to Pulumi

### 7.3 Phase 3: Full Pulumi (Production)

**Goal**: All infrastructure and functions managed as code.

**Pulumi stack** (`infra/prod/Pulumi.prod.yaml`):
```typescript
// Full Pulumi stack from AIW001
// All resources, including functions, managed as code
```

**Migration path**:
1. Export existing resources to Pulumi state
2. Update Pulumi code to match current state
3. Verify with `pulumi preview`
4. Apply and manage via Pulumi going forward

---

## 8) Security Considerations for Local Development

### 8.1 Secret Handling

**Local**:
- Secrets in `.env` (gitignored)
- Never commit API keys
- Rotate keys periodically
- Use separate dev API keys when possible

**Production**:
- Secrets in Secret Manager
- Accessed via service account with least privilege
- Rotated on schedule

### 8.2 Network Isolation

**Local**: Functions run on `localhost` with no external exposure.

**Production**: Functions use IAM for authentication, ingress restrictions, and VPC controls.

### 8.3 Authentication

**Local**: No authentication required (localhost only).

**Production**: 
- HTTP functions: IAM or signed requests (Slack verification)
- Pub/Sub functions: Service account with subscriber role

---

## 9) Telemetry and Observability (Local)

### 9.1 Local Logging

**Pattern**: Use structured logging that works both locally and in production.

```typescript
// src/utils/logger.ts
import { Logging } from "@google-cloud/logging";

const isLocal = process.env.NODE_ENV !== "production";

export const logger = {
  info: (msg: string, meta?: Record<string, any>) => {
    if (isLocal) {
      console.log(`[INFO] ${msg}`, meta);
    } else {
      // Cloud Logging in production
      const logging = new Logging();
      logging.log("agent-function").info(msg, meta);
    }
  },
  error: (msg: string, error?: Error, meta?: Record<string, any>) => {
    if (isLocal) {
      console.error(`[ERROR] ${msg}`, error, meta);
    } else {
      // Cloud Error Reporting in production
      const logging = new Logging();
      logging.log("agent-function").error(msg, { error, ...meta });
    }
  },
};
```

### 9.2 Datadog Integration (Local)

**Assumption**: Teams have full access to Datadog locally.

**Setup**:
```typescript
// src/utils/telemetry.ts
import * as datadog from "dd-trace";

if (process.env.DATADOG_ENABLED === "true") {
  datadog.init({
    service: "agent-function-local",
    env: "local",
  });
}

export const trackMetric = (name: string, value: number, tags?: Record<string, string>) => {
  if (process.env.DATADOG_ENABLED === "true") {
    datadog.dogstatsd.gauge(name, value, tags);
  }
};
```

**Usage**:
```typescript
import { trackMetric } from "./utils/telemetry";

trackMetric("agent.execution.time", duration, { agent: "pr-reviewer" });
```

### 9.3 Feature Flags (Local)

**Assumption**: Teams have full access to feature flag service locally.

**Pattern**: Use feature flags to toggle agent behavior without code changes.

```typescript
// src/utils/feature-flags.ts
import { getFeatureFlag } from "./feature-flag-service"; // Your service

export async function shouldUseNewAgent(correlationId: string): Promise<boolean> {
  return await getFeatureFlag("use-new-pr-reviewer", correlationId);
}
```

---

## 10) Practical Code Examples

### 10.1 Complete Router Function (Local-Ready)

```typescript
// src/functions/router.ts
import { http } from "@google-cloud/functions-framework";
import { PubSub } from "@google-cloud/pubsub";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { pubsub } from "../config/pubsub";

const topicName = process.env.PUBSUB_TOPIC || "agents-main";

http("router", async (req, res) => {
  const correlationId = crypto.randomUUID();
  logger.info("Router request received", { correlationId });

  // Verify Slack signature (skip in local dev for testing)
  if (process.env.NODE_ENV === "production") {
    const isValid = verifySlackSignature(req);
    if (!isValid) {
      logger.error("Invalid Slack signature", undefined, { correlationId });
      return res.status(401).send("Unauthorized");
    }
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  
  const message = {
    version: "1.0",
    correlation_id: payload.correlation_id || correlationId,
    agent: payload.agent,
    context: payload.context || {},
    reply: payload.reply || {},
    timeouts: payload.timeouts || { hard_seconds: 900 },
  };

  try {
    await pubsub.topic(topicName).publishMessage({ json: message });
    logger.info("Message published to Pub/Sub", { correlationId, topic: topicName });
    
    res.status(202).json({ ok: true, id: message.correlation_id });
  } catch (error) {
    logger.error("Failed to publish message", error as Error, { correlationId });
    res.status(500).json({ error: "Failed to publish message" });
  }
});

function verifySlackSignature(req: any): boolean {
  // Implementation from AIW001
  // Omitted for brevity
  return true;
}
```

### 10.2 Complete Worker Function (Local-Ready)

```typescript
// src/functions/worker.ts
import { cloudEvent } from "@google-cloud/functions-framework";
import { spawn } from "child_process";
import { Buffer } from "node:buffer";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";

type PubSubMessage = {
  data?: {
    message?: {
      data?: string;
    };
  };
};

function decodeMessage(event: any) {
  try {
    const b64 = event?.data?.message?.data;
    if (!b64) throw new Error("No message data");
    const raw = Buffer.from(b64, "base64").toString();
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed Pub/Sub message: ${error}`);
  }
}

async function runCursorAgent(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn("./node_modules/.bin/cursor-agent", args, { env, shell: true });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

cloudEvent<PubSubMessage>("worker", async (event) => {
  const msg = decodeMessage(event);
  const correlationId = msg.correlation_id || "unknown";
  
  logger.info("Worker processing message", { correlationId, agent: msg.agent?.name });

  const args = [
    "--name", msg.agent?.name ?? "default",
    "--input", JSON.stringify(msg),
  ];

  const { code, stdout, stderr } = await runCursorAgent(args, {
    ...process.env,
    CURSOR_API_KEY: secrets.cursorApiKey,
  });

  if (code !== 0) {
    logger.error("Cursor agent failed", new Error(stderr), { correlationId });
    throw new Error(`Cursor agent failed: ${stderr.slice(0, 4000)}`);
  }

  logger.info("Cursor agent completed", { correlationId, outputLength: stdout.length });

  // Handle reply sinks (GitHub, Slack, etc.)
  if (msg.reply?.type === "github.pr_review") {
    await postGitHubReview(msg.reply.targets, stdout, correlationId);
  }

  if (msg.reply?.type === "slack.message") {
    await postSlackMessage(msg.reply.targets.response_url, stdout, correlationId);
  }
});

async function postGitHubReview(targets: any, body: string, correlationId: string) {
  // Implementation from AIW001
  logger.info("Posting GitHub review", { correlationId, repo: targets.repo });
}

async function postSlackMessage(responseUrl: string, body: string, correlationId: string) {
  // Implementation from AIW001
  logger.info("Posting Slack message", { correlationId });
}
```

### 10.3 Configuration Module

```typescript
// src/config/index.ts
import dotenv from "dotenv";
import { PubSub } from "@google-cloud/pubsub";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

export const config = {
  gcp: {
    projectId: process.env.GCP_PROJECT_ID || "dev-local",
    region: process.env.GCP_REGION || "us-central1",
  },
  local: {
    functionsPort: parseInt(process.env.FUNCTIONS_PORT || "8080", 10),
    pubsubEmulatorPort: parseInt(process.env.PUBSUB_EMULATOR_PORT || "8085", 10),
    useEmulator: process.env.USE_EMULATOR === "true",
  },
  pubsub: {
    mainTopic: process.env.PUBSUB_TOPIC || "agents-main",
    dlqTopic: process.env.PUBSUB_DLQ_TOPIC || "agents-dlq",
  },
};

// Initialize Pub/Sub client
if (config.local.useEmulator) {
  process.env.PUBSUB_EMULATOR_HOST = `localhost:${config.local.pubsubEmulatorPort}`;
  console.log(`[LOCAL] Using Pub/Sub emulator at ${process.env.PUBSUB_EMULATOR_HOST}`);
}

export const pubsub = new PubSub({
  projectId: config.gcp.projectId,
});
```

---

## 11) Testing Strategy

### 11.1 Unit Tests

**Focus**: Test business logic, not GCP integrations.

```typescript
// src/functions/__tests__/router.test.ts
import { describe, it, expect } from "@jest/globals";

describe("Router", () => {
  it("should generate correlation ID if missing", () => {
    const payload = { agent: { name: "test" } };
    // Test correlation ID generation logic
  });
});
```

### 11.2 Integration Tests (Local)

**Focus**: Test with emulators, verify end-to-end flow.

```typescript
// src/__tests__/integration/router-worker.test.ts
import { PubSub } from "@google-cloud/pubsub";
import fetch from "node-fetch";

describe("Router → Worker Integration", () => {
  it("should publish message and worker should process it", async () => {
    // Start emulator and functions in test setup
    // Send HTTP request to router
    // Verify worker receives and processes message
  });
});
```

### 11.3 Manual Testing Scripts

**Purpose**: Quick validation during development.

```bash
# scripts/test-agent.sh
#!/bin/bash
curl -X POST http://localhost:8080/router \
  -H "Content-Type: application/json" \
  -d @test-payloads/pr-review.json
```

---

## 12) Common Pitfalls and Solutions

### 12.1 Emulator Port Conflicts

**Problem**: Multiple developers running emulators on same port.

**Solution**: Use different ports per developer:
```bash
PUBSUB_EMULATOR_PORT=8086 npm run dev:worker
```

### 12.2 Secret Manager Not Available Locally

**Problem**: Production code expects Secret Manager, but it's not available locally.

**Solution**: Use environment-based configuration:
```typescript
const getSecret = async (name: string) => {
  if (process.env.USE_EMULATOR === "true") {
    return process.env[name] || process.env[`SECRET_${name}`];
  }
  // Use Secret Manager in production
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name });
  return version.payload?.data?.toString();
};
```

### 12.3 Functions Framework Not Finding Entry Point

**Problem**: `functions-framework` can't find the compiled JavaScript.

**Solution**: Ensure TypeScript compiles to `dist/` and use `--source=dist`:
```json
{
  "scripts": {
    "dev": "npm run build && functions-framework --target=router --source=dist"
  }
}
```

---

## 13) Deployment Workflow: Local → Dev → Prod

### 13.1 Local Development

- All testing happens locally with emulators
- No GCP resources needed
- Fast iteration cycle

### 13.2 Dev Project Deployment (Clickops)

- Deploy to dev GCP project for integration testing
- Use `gcloud` commands or Console
- Verify with real Pub/Sub, Secret Manager, etc.

### 13.3 Production Deployment (Pulumi)

- All infrastructure managed as code
- Automated via CI/CD
- Full observability and security controls

---

## 14) Success Metrics

**Developer Experience**:
- Time to first working local environment: **< 10 minutes**
- Time to test a code change locally: **< 30 seconds**
- Number of cloud deployments needed for basic iteration: **0**

**Quality**:
- Percentage of bugs caught locally before cloud deployment: **> 80%**
- Reduction in production incidents from local testing: **> 50%**

---

## 15) Open Questions

- Should we standardize on a specific testing framework (Jest vs. Mocha)?
- Do we need a shared local development environment setup script?
- How should teams handle shared emulator instances for team testing?
- What's the recommended approach for testing Cursor CLI integration locally?

---

## 16) References

- [Google Cloud Functions Framework](https://github.com/GoogleCloudPlatform/functions-framework-nodejs)
- [Pub/Sub Emulator](https://cloud.google.com/pubsub/docs/emulator)
- [Cloud Run Functions Local Development](https://cloud.google.com/functions/docs/2nd-gen/local-development)
- [Functions Framework Debugging](https://github.com/GoogleCloudPlatform/functions-framework-nodejs#debugging)
- AIW001: Reference Architecture for Agentic Automations on GCP

---

## 17) Appendix: Complete Setup Script

**`scripts/setup-local.sh`**:
```bash
#!/bin/bash
set -e

echo "Setting up local development environment..."

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: Install Node.js 20+"; exit 1; }
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: Install gcloud CLI"; exit 1; }

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Install Pub/Sub emulator if not present
if ! gcloud components list --filter="id:pubsub-emulator" --format="value(state.name)" | grep -q "Installed"; then
  echo "Installing Pub/Sub emulator..."
  gcloud components install pubsub-emulator
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo "Creating .env file..."
  cp .env.example .env
  echo ""
  echo "Please edit .env and add your API keys:"
  echo "  - CURSOR_API_KEY"
  echo "  - GITHUB_TOKEN (optional)"
  echo "  - SLACK_SIGNING_SECRET (optional)"
  echo ""
  read -p "Press enter when .env is configured..."
fi

# Build TypeScript
echo "Building TypeScript..."
npm run build

echo ""
echo "Setup complete! To start local development:"
echo "  npm run dev:all"
echo ""
```

Make it executable:
```bash
chmod +x scripts/setup-local.sh
```

---

**End of RFC**
