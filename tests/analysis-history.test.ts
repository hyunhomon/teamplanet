import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { collectionFixture } from "./helpers/collection";
import { analysisHistoryRoutes } from "../apps/api/src/analysis-history";
import type { ProtectedEnv } from "../apps/api/src/guard";
import { professors } from "@teamplanet/contracts/fixtures";
import { DashboardController } from "../apps/web/src/lib/analysis-dashboard";
import { analysisRoutes } from "../apps/api/src/analysis";
import { queueJobSchema } from "@teamplanet/contracts";
let f:Awaited<ReturnType<typeof collectionFixture>>,app:Hono<ProtectedEnv>,professor:(typeof professors)[number];
beforeEach(async()=>{
 f=await collectionFixture();professor=f.professor;
 f.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1','[\"clarity\"]',0)",[f.course.id]);
 app=new Hono<ProtectedEnv>();app.use('*',async(c,next)=>{c.set('professor',professor);await next();});
 app.route('/v1',analysisHistoryRoutes(f.now));app.route('/v1',analysisRoutes(f.now));
});
afterEach(()=>f.sqlite.close());
const range=()=>({teamId:f.teamId,from:new Date(f.start).toISOString(),to:new Date(f.start+200000).toISOString(),timezone:'Asia/Seoul'});
const call=(body:any,env:any={DB:f.db})=>app.request('https://synthetic/v1/analysis-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},env);
test('a professor can enqueue missing coverage without a model run; same request is one durable job and changed bounds conflict',async()=>{
 const body={...range(),requestId:crypto.randomUUID()};
 expect((await call(body)).status).toBe(200);expect((await call(body)).status).toBe(200);
 expect(f.sqlite.query('SELECT * FROM queue_jobs').all()).toHaveLength(1);expect(f.sqlite.query('SELECT * FROM analysis_runs').all()).toHaveLength(0);
 expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.history_request'").all()).toHaveLength(1);
 const row=f.sqlite.query('SELECT job_json FROM queue_jobs').get() as {job_json:string};
 expect(row.job_json).toBe(JSON.stringify(queueJobSchema.parse(JSON.parse(row.job_json))));
 expect((await call({...body,to:new Date(f.start+300000).toISOString()})).status).toBe(409);
 const status=await app.request(`https://synthetic/v1/teams/${f.teamId}/analysis-history/${body.requestId}`,{}, {DB:f.db});
 expect(await status.json()).toMatchObject({status:'pending',coverage:'missing',requestId:body.requestId});
});
test('ownership, current consent, future period, inactive collection and unknown request deny collection before dispatch',async()=>{
 const body={...range(),requestId:crypto.randomUUID()};professor=professors[1]!;expect((await call(body)).status).toBe(404);professor=f.professor;
 expect((await call({...body,to:new Date(f.now()+1000).toISOString()})).status).toBe(409);
 f.sqlite.run("UPDATE teams SET collection_status='paused' WHERE id=?",[f.teamId]);expect((await call(body)).status).toBe(409);
 f.sqlite.run("UPDATE teams SET collection_status='active' WHERE id=?",[f.teamId]);
 f.sqlite.run("UPDATE consents SET status='withdrawn',recorded_at=?",[f.now()]);expect((await call(body)).status).toBe(409);
 expect(f.sqlite.query('SELECT * FROM queue_jobs').all()).toHaveLength(0);
});
test('a reused global History request cannot mutate another team coverage record',async()=>{
 const id=crypto.randomUUID();
 f.sqlite.run("INSERT INTO queue_jobs (job_key,job_json,created_at,updated_at) VALUES (?,?,0,0)",['history:other:'+id,JSON.stringify({kind:'slack.history',teamId:'team_other',requestId:id,fromMs:f.start,toMs:f.start+1})]);
 expect((await call({...range(),requestId:id})).status).toBe(409);
 expect(f.sqlite.query('SELECT * FROM queue_jobs').all()).toHaveLength(1);
});
test('withdrawal racing the collection outbox insert rolls the request back',async()=>{
 const db={...f.db,batch:async(statements:any[])=>{f.sqlite.run("UPDATE consents SET status='withdrawn',recorded_at=?",[f.now()]);return f.db.batch(statements);}};
 expect((await call({...range(),requestId:crypto.randomUUID()},{DB:db})).status).toBe(409);
 expect(f.sqlite.query('SELECT * FROM queue_jobs').all()).toHaveLength(0);
});
test('a lost History response reuses the same request ID through the actual dashboard controller',async()=>{
 let lost=true;const sent:string[]=[];
 const fetcher=(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const response=await app.request(`https://synthetic${url}`,init,{DB:f.db});
  if(String(url).endsWith('/analysis-history')&&init?.method==='POST'){sent.push(JSON.parse(String(init.body)).requestId);if(lost){lost=false;throw Error('synthetic lost response');}}
  return response;
 }) as typeof fetch;
 const controller=new DashboardController(()=>{},f.professor.id,{getItem:()=>null,setItem(){},removeItem(){}},fetcher,{teamId:f.teamId,runId:''},f.now);
 await controller.load();controller.setRange(range());await controller.preview();await controller.collectHistory();
 await controller.preview();await controller.collectHistory();expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1]);
 expect(controller.getSnapshot().history?.status).toBe('pending');
});

