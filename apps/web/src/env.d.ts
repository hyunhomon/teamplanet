/// <reference types="astro/client" />

declare namespace Cloudflare {
  interface Env {
    API: { fetch(request: Request): Promise<Response> };
  }
}
