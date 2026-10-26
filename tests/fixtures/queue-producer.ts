import { queueJobSchema } from "@teamplanet/contracts";
import { enqueueJob, JobStore } from "@teamplanet/queue";
import type { Bindings } from "../../apps/consumer/src/index";

// Local harness only. Never included in production configuration or deployed.
export default {
  async fetch(request: Request, env: Bindings) {
    const key = await enqueueJob(new JobStore(env.DB), env.WORK_QUEUE, queueJobSchema.parse(await request.json()));
    return Response.json({ key });
  },
};
