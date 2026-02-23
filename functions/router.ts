import { http } from "@google-cloud/functions-framework";
import { PubSub } from "@google-cloud/pubsub";
import crypto from "crypto";

const topic = process.env.PUBSUB_TOPIC!;
const pubsub = new PubSub();

function verifySlack(req: any): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const body =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  const computedSig = `v0=${hmac.update(baseString).digest("hex")}`;

  return crypto.timingSafeEqual(
    Buffer.from(computedSig, "utf8"),
    Buffer.from(signature, "utf8"),
  );
}

http("router", async (req, res) => {
  const source = req.headers["user-agent"]?.includes("Slackbot")
    ? "slack"
    : "other";

  if (source === "slack" && !verifySlack(req))
    return res.status(401).send("bad sig");

  const payload =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;
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
