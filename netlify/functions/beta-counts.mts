import type { Config, Context } from "@netlify/functions";

// Returns live Founding Beta counts from the Supabase `beta_counts` RPC so the
// landing page can render a real number instead of a hardcoded one. Calls
// with the publishable anon key -- beta_counts is SECURITY DEFINER with
// EXECUTE granted to anon, and nothing else on this table is anon-reachable.

interface CountRow {
  founding_count: number;
  founding_limit: number;
  total: number;
}

export default async (_req: Request, _context: Context): Promise<Response> => {
  const url = Netlify.env.get("SUPABASE_URL");
  const key = Netlify.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) {
    return new Response(JSON.stringify({ error: "server_not_configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const res = await fetch(`${url}/rest/v1/rpc/beta_counts`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) throw new Error(`beta_counts_${res.status}`);
    const rows = (await res.json()) as CountRow[];
    const counts = (Array.isArray(rows) && rows[0]) || {
      founding_count: 0,
      founding_limit: 50,
      total: 0,
    };
    return new Response(JSON.stringify(counts), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=30",
      },
    });
  } catch (err) {
    console.error("beta-counts error:", (err as Error).message);
    return new Response(JSON.stringify({ error: "counts_unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/beta-counts",
};
