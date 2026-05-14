import { json, type ActionFunctionArgs } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { captureFrontendError } from "~/lib/merchant-qa.server";

// Phase 3.8 D — frontend-error sink. The root error boundary POSTs
// here when the merchant sees a runtime React/JS error during QA, and
// this loader forwards a redacted event to AppApprove. Same auth model
// as the rest of the QA pipeline (the generated app trusts its own
// frontend; AppApprove trusts the deploy-secret HMAC inside
// captureFrontendError → reportToAppApprove).

interface ErrorReportBody {
  message: string;
  url?: string;
  stack?: string;
  componentStack?: string;
}

export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const env = (context.cloudflare?.env ?? {}) as Env;
  let body: ErrorReportBody;
  try {
    body = (await request.json()) as ErrorReportBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return json({ ok: false, error: "message is required" }, { status: 400 });
  }
  await captureFrontendError(env, body.message.slice(0, 2000), {
    ...(body.url ? { url: String(body.url).slice(0, 500) } : {}),
    ...(body.stack ? { stack: String(body.stack).slice(0, 1500) } : {}),
    ...(body.componentStack
      ? { componentStack: String(body.componentStack).slice(0, 1500) }
      : {}),
  });
  return json({ ok: true });
}
