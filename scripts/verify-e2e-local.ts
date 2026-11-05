import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import { chromium } from "playwright-core";
import { strict as assert } from "node:assert";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { flushOutbox, JobStore } from "@teamplanet/queue";
import { bindings, identity, syntheticProvider } from "../tests/e2e/provider";
import { runBrowserJourney } from "../tests/e2e/journey";

const root=resolve(import.meta.dir,".."), cache=join(root,"node_modules/.cache");mkdirSync(cache,{recursive:true});
const dir=process.env.TEAMPLANET_E2E_DIR??mkdtempSync(join(cache,"e2e-local-"));
if(!process.env.TEAMPLANET_E2E_NODE){
  const workers=await Bun.build({entrypoints:[join(root,"tests/e2e/api-worker.ts"),join(root,"tests/e2e/consumer-worker.ts")],root,outdir:dir,target:"browser",format:"esm"});
  if(!workers.success)throw Error(`E2E worker build: ${workers.logs}`);
  const web=await Bun.build({entrypoints:[join(root,"apps/web/dist/server/entry.mjs")],outdir:join(dir,"web"),target:"browser",format:"esm",external:["cloudflare:workers","node:*"]});
  if(!web.success)throw Error(`E2E built SSR bundle: ${web.logs}`);
  const runner=await Bun.build({entrypoints:[import.meta.path],target:"node",format:"esm",external:["miniflare","drizzle-orm/migrator","zod","playwright-core"],outdir:join(dir,"runner"),define:{"import.meta.dir":JSON.stringify(import.meta.dir)}});
  if(!runner.success)throw Error(`E2E runner build: ${runner.logs}`);
  const child=Bun.spawn(["node",runner.outputs[0]!.path],{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:{...process.env,TEAMPLANET_E2E_NODE:"1",TEAMPLANET_E2E_DIR:dir}});process.exit(await child.exited);
}
const started=performance.now(),provider=syntheticProvider(), common={compatibilityDate:"2026-10-24",compatibilityFlags:["nodejs_compat"],outboundService:provider.send};
const d1Databases={DB:"e2e-isolated"},queue="e2e-jobs",dlq="e2e-dlq";
const options={host:"127.0.0.1",port:0,defaultPersistRoot:join(dir,"state"),workers:[
  {name:"e2e-web",modules:true,scriptPath:join(dir,"web/entry.js"),...common,serviceBindings:{API:"e2e-api"},kvNamespaces:["SESSION"],
    assets:{directory:join(root,"apps/web/dist/client"),binding:"ASSETS",routerConfig:{has_user_worker:true}}},
  {name:"e2e-api",modules:true,scriptPath:join(dir,"tests/e2e/api-worker.js"),...common,bindings,d1Databases,queueProducers:{WORK_QUEUE:queue}},
  {name:"e2e-consumer",modules:true,scriptPath:join(dir,"tests/e2e/consumer-worker.js"),...common,bindings,d1Databases,
    queueProducers:{WORK_QUEUE:queue,DEAD_LETTER_QUEUE:dlq},queueConsumers:{[queue]:{maxBatchSize:1,maxBatchTimeout:0,maxRetries:4,retryDelay:1,deadLetterQueue:dlq}}},
]};
const mf=new Miniflare(convertV4MiniflareOptions(options as unknown as V4MiniflareOptions));let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
try{
  let connection=await mf.getD1Database("DB","e2e-api");
  const db={prepare:(sql:string)=>connection.prepare(sql),batch:(statements:any[])=>connection.batch(statements)};
  for(const migration of readMigrationFiles({migrationsFolder:join(root,"packages/db/migrations")}))await db.batch(migration.sql.map(sql=>db.prepare(sql.trim())));
  await db.prepare("CREATE TABLE e2e_deliveries (id TEXT PRIMARY KEY)").run();
  await db.batch([db.prepare("INSERT INTO professors VALUES (?, ?, 0)").bind(identity.professor,identity.email),db.prepare("INSERT INTO professors VALUES (?, ?, 0)").bind(identity.otherProfessor,identity.otherEmail),
    db.prepare("INSERT INTO consent_policies VALUES ('e2e-form-v1',0,'synthetic-operator')")]);
  let producer=await mf.getQueueProducer("WORK_QUEUE","e2e-api"),dead=await mf.getQueueProducer("DEAD_LETTER_QUEUE","e2e-consumer");
  const probe={kind:"system.probe" as const,probeId:crypto.randomUUID()};
  const store=new JobStore(db as unknown as D1Database,()=>provider.state.now);
  const row=await store.register(probe);
  await producer.send({version:1,generation:0,job:probe});
  const until=Date.now()+10000;
  while((await store.get(row.job_key))?.status!=="completed"){
    if(Date.now()>until)throw Error(`Native E2E Queue probe failed: ${JSON.stringify(await store.get(row.job_key))}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  console.log("PASS E2E isolated native Queue/Consumer readiness");
  let flushing=false,paused=false;let backgroundError:unknown;
  timer=setInterval(()=>{if(flushing||paused)return;flushing=true;void flushOutbox(new JobStore(db as unknown as D1Database,()=>provider.state.now),producer as unknown as Queue<any>,dead as unknown as Queue<any>)
    .catch(e=>{backgroundError=e;console.error("Synthetic outbox transport failure",String(e));}).finally(()=>{flushing=false;});},100);
  const base=String(await mf.ready);
  const executablePath=process.env.E2E_CHROMIUM_EXECUTABLE;
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  await runBrowserJourney({browser,base,db:db as unknown as D1Database,provider,dir,restart:async()=>{
    paused=true;while(flushing)await new Promise(resolve=>setTimeout(resolve,20));
    await mf.setOptions(convertV4MiniflareOptions({...options,port:Number(new URL(base).port),workers:options.workers.map(w=>w.name==="e2e-consumer"?{...w,bindings:{...bindings,E2E_RESTART_REVISION:1}}:w)} as unknown as V4MiniflareOptions));
    await mf.ready;connection=await mf.getD1Database("DB","e2e-api");
    producer=await mf.getQueueProducer("WORK_QUEUE","e2e-api");dead=await mf.getQueueProducer("DEAD_LETTER_QUEUE","e2e-consumer");paused=false;
  }});
  if(backgroundError)throw backgroundError;
  assert.deepEqual(provider.state.unexpected,[]);
  console.log(`PASS synthetic full-stack E2E in ${((performance.now()-started)/1000).toFixed(1)}s; isolated local state, no real external service`);
}finally{if(timer)clearInterval(timer);await browser?.close();await mf.dispose();}
