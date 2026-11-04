// Alertmanager webhook receiver.
//
// Alertmanager groups alerts and POSTs a notification per group. Every notification for
// the same group lands in the same incident session (the session id is derived from the
// group key), and the first firing notification kicks off the triage Workflow, so a
// severity call and hypotheses are ready by the time the on-call engineer opens the link.
//
// Payload reference: https://prometheus.io/docs/alerting/latest/configuration/#webhook_config

type Alert = {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
};

export type AlertmanagerPayload = {
  version?: string;
  groupKey: string;
  status: "firing" | "resolved";
  receiver?: string;
  commonLabels?: Record<string, string>;
  externalURL?: string;
  alerts: Alert[];
};

const MAX_ALERTS_IN_MESSAGE = 20;

export function isAlertmanagerPayload(x: unknown): x is AlertmanagerPayload {
  const p = x as AlertmanagerPayload;
  return (
    !!p &&
    typeof p.groupKey === "string" &&
    (p.status === "firing" || p.status === "resolved") &&
    Array.isArray(p.alerts)
  );
}

/**
 * Same alert group → same session id, formatted like a UUID so it fits the session routes.
 * HMAC-keyed with the webhook secret: group keys are predictable, session ids must not be.
 */
export async function sessionIdForGroup(groupKey: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, enc.encode(`alertmanager:${groupKey}`));
  const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Renders a notification as an incident-timeline message the LLM can reason about. */
export function formatAlertMessage(p: AlertmanagerPayload): string {
  const firing = p.alerts.filter((a) => a.status === "firing");
  const resolved = p.alerts.filter((a) => a.status === "resolved");

  const line = (a: Alert) => {
    const { alertname = "unknown", severity, ...rest } = a.labels ?? {};
    const where = Object.entries(rest)
      .filter(([k]) => ["instance", "job", "namespace", "pod", "service", "cluster", "host", "node", "topic", "group"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const desc = a.annotations?.summary || a.annotations?.description || "";
    return `- ${alertname}${severity ? ` [${severity}]` : ""}${where ? ` (${where})` : ""}${
      a.startsAt ? ` since ${a.startsAt}` : ""
    }${desc ? `: ${desc}` : ""}`;
  };

  const parts = [`[Alertmanager] Notification: ${p.status.toUpperCase()} (${firing.length} firing, ${resolved.length} resolved)`];
  if (firing.length) parts.push("Firing:", ...firing.slice(0, MAX_ALERTS_IN_MESSAGE).map(line));
  if (resolved.length) parts.push("Resolved:", ...resolved.slice(0, MAX_ALERTS_IN_MESSAGE).map(line));
  if (p.alerts.length > MAX_ALERTS_IN_MESSAGE * 2) parts.push(`(+${p.alerts.length - MAX_ALERTS_IN_MESSAGE * 2} more not shown)`);
  return parts.join("\n").slice(0, 6000);
}

/** Constant-time bearer token check. The webhook is disabled until ALERT_WEBHOOK_TOKEN is set. */
export function authorised(request: Request, token: string | undefined): boolean | "disabled" {
  if (!token) return "disabled";
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(token);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
