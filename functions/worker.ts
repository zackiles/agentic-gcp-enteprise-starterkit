import { cloudEvent } from "@google-cloud/functions-framework";
import { spawn, execFileSync } from "child_process";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import fetch from "node-fetch";

const CURSOR_BIN = "cursor-agent";

type PubSubEvent = { data?: { message?: { data?: string } } };

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

      const timer = setTimeout(() => {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        reject(
          new Error(`cursor-agent exceeded ${hardSeconds}s hard timeout`),
        );
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
    "--name",
    msg.agent?.name ?? "default",
    "--input",
    JSON.stringify(msg),
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
