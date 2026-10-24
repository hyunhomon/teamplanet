import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

// Preserve method, URL, headers, cookies, and body through the private service binding.
export const ALL: APIRoute = async ({ request }) => {
  try {
    return await env.API.fetch(request);
  } catch {
    return Response.json({ error: { code: "API_UNAVAILABLE" } }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
