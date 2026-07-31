import type { Config, Context } from "@netlify/functions";

// Saves a Founding Beta signup by calling the Supabase `claim_beta_signup`
// RPC with the service-role key (RLS on `beta_signups` allows service-role
// only). The DB function owns dedup + founding/waitlist assignment; this
// function is a thin, validated pass-through.

interface ClaimRow {
  out_email: string;
  out_founding: boolean;
  out_is_new: boolean;
  out_status: string;
}
interface CountRow {
  founding_count: number;
  founding_limit: number;
  total: number;
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const url = Netlify.env.get("SUPABASE_URL");
  const key = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("missing_supabase_env");

  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`rpc_${fn}_${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  // Accept either a JSON body or an encoded form post.
  let body: Record<string, unknown> = {};
  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      body = (await req.json()) as Record<string, unknown>;
    } else {
      const form = await req.formData();
      body = Object.fromEntries(form.entries());
    }
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const asText = (v: unknown): string =>
    typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();

  // The DB enforces a CHECK constraint on care_role, so map the form's
  // family_type values to those exact allowed values.
  const CARE_ROLE_MAP: Record<string, string> = {
    one_child: "one-child",
    multiple_children: "multiple-children",
    self: "myself",
    adult_family: "family-member",
    caregiver: "caregiver",
    // Accept already-normalized values too, so this stays correct if the
    // form is ever changed to send the DB values directly.
    "one-child": "one-child",
    "multiple-children": "multiple-children",
    myself: "myself",
    "family-member": "family-member",
  };

  // Column CHECK limits: first_name 1..80, referral_source <=200.
  const firstName = asText(body.name ?? body.first_name).slice(0, 80);
  const email = asText(body.email);
  const familyType = asText(body.family_type ?? body.care_role);
  const careRole = CARE_ROLE_MAP[familyType];
  const referral = asText(body.referral ?? body.referral_source).slice(0, 200);

  if (!firstName || !email) {
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: "invalid_email" }, 400);
  }
  if (!careRole) {
    return jsonResponse({ error: "invalid_care_role" }, 400);
  }

  try {
    const rows = await callRpc<ClaimRow[]>("claim_beta_signup", {
      p_first_name: firstName,
      p_email: email,
      p_care_role: careRole,
      p_referral_source: referral || null,
    });
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new Error("empty_claim_response");

    // Counts are a nice-to-have for the UI; never fail the signup over them.
    let counts: CountRow | null = null;
    try {
      const c = await callRpc<CountRow[]>("beta_counts", {});
      counts = Array.isArray(c) ? c[0] ?? null : null;
    } catch {
      counts = null;
    }

    return jsonResponse({
      ok: true,
      founding: row.out_founding,
      is_new: row.out_is_new,
      status: row.out_status,
      email: row.out_email,
      counts,
    });
  } catch (err) {
    // Keep internals out of the client response; detail stays in server logs.
    console.error("submit-beta-signup error:", (err as Error).message);
    return jsonResponse({ error: "signup_failed" }, 502);
  }
};

export const config: Config = {
  path: "/api/beta-signup",
};
