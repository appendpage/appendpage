import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pool } from "../src/lib/db";
import { deliverReportEmail, previewReportEmail, type ReportEmail } from "../src/lib/report-email";

const transport = fileURLToPath(new URL("./report-email-smtp.py", import.meta.url));

function send(email: ReportEmail): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [transport], {
      stdio: ["pipe", "ignore", "ignore"], timeout: 75_000,
      // The transport needs mail credentials only, never database credentials.
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV ?? "production",
        REPORT_EMAIL_USER: process.env.REPORT_EMAIL_USER,
        REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO,
        GOOGLE_APP_PASSWORD: process.env.GOOGLE_APP_PASSWORD,
      },
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Mail delivery failed")));
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(email));
  });
}

async function main() {
  if (process.argv.includes("--preview")) {
    console.log(JSON.stringify({ enabled: process.env.REPORT_EMAIL_ENABLED === "1", ...await previewReportEmail() }));
    return;
  }
  const result = await deliverReportEmail(send, process.env.REPORT_EMAIL_ENABLED === "1");
  // No post text, report explanations, addresses, credentials, or SMTP replies.
  console.log(JSON.stringify({ report_email: result }));
  if (result === "retry") process.exitCode = 1;
}

main().catch(() => { console.error("report_email_worker_failed"); process.exitCode = 1; })
  .finally(async () => { if (globalThis.__appendpage_pg_pool) await pool.end(); });
