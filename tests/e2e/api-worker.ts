import { createApp, type Bindings } from "../../apps/api/src/index";
import { defaultAuthDeps } from "../../apps/api/src/auth";
// Test entrypoint only: production routes/mailer/guards, with an injectable synthetic clock.
export default { async fetch(request: Request, env: Bindings, context: any) {
  const at = Number(await (await fetch("https://synthetic.invalid/clock")).text());
  return createApp({ ...defaultAuthDeps, now: () => at }).fetch(request, env, context);
} };
