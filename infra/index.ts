import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const region = "us-central1";

const dlq = new gcp.pubsub.Topic("agents-dlq", { name: "agents-dlq" });
const main = new gcp.pubsub.Topic("agents-main", { name: "agents-main" });

new gcp.pubsub.Subscription("agents-sub", {
  topic: main.name,
  deadLetterPolicy: {
    deadLetterTopic: dlq.id,
    maxDeliveryAttempts: 10,
  },
  retryPolicy: { minimumBackoff: "10s", maximumBackoff: "300s" },
});

const cursorSecret = new gcp.secretmanager.Secret("cursor-api-key", {
  replication: { auto: {} },
});
new gcp.secretmanager.SecretVersion("cursor-api-key-v1", {
  secret: cursorSecret.id,
  secretData: pulumi.secret("PLACEHOLDER_SET_IN_CI"),
});

new gcp.cloudfunctionsv2.Function("router-fn", {
  location: region,
  name: "agents-router",
  buildConfig: {
    runtime: "nodejs22",
    entryPoint: "router",
    source: {
      repoSource: { repoName: "agents-mono", branchName: "main" },
    },
  },
  serviceConfig: {
    availableMemory: "1Gi",
    timeoutSeconds: 300,
    environmentVariables: { PUBSUB_TOPIC: main.name },
    serviceAccountEmail: "router-sa@PROJECT.iam.gserviceaccount.com",
  },
});

new gcp.cloudfunctionsv2.Function("pr-reviewer-fn", {
  location: region,
  name: "agent-pr-reviewer",
  buildConfig: {
    runtime: "nodejs22",
    entryPoint: "worker",
    source: {
      repoSource: { repoName: "agents-mono", branchName: "main" },
    },
  },
  serviceConfig: {
    availableMemory: "2Gi",
    maxInstanceCount: 50,
    maxInstanceRequestConcurrency: 1,
    timeoutSeconds: 1800,
    environmentVariables: {
      CURSOR_API_KEY_SECRET: cursorSecret.id,
    },
    secretEnvironmentVariables: [
      {
        key: "CURSOR_API_KEY",
        projectId: "PROJECT",
        secret: cursorSecret.name,
        version: "latest",
      },
    ],
    serviceAccountEmail: "worker-sa@PROJECT.iam.gserviceaccount.com",
  },
  eventTrigger: {
    eventType: "google.cloud.pubsub.topic.v1.messagePublished",
    pubsubTopic: main.id,
    triggerRegion: region,
    retryPolicy: "RETRY_POLICY_DO_NOT_RETRY",
  },
});
