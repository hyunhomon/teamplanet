import type { Browser } from 'playwright-core';
import type { D1Database } from '@cloudflare/workers-types';
import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { identity, bindings, type syntheticProvider } from './provider';
export async function runBrowserJourney({browser,base,db,provider,dir,restart}:{browser:Browser;base:string;db:D1Database;provider:ReturnType<typeof syntheticProvider>;dir:string;restart():Promise<void>}) {
 const periodFrom=new Date(provider.state.origin).toISOString(),periodTo=new Date(provider.state.origin+60000).toISOString();
 const seoulMinute=(iso:string)=>new Date(Date.parse(iso)+9*3600000).toISOString().slice(0,16);
 const context=await browser.newContext({viewport:{width:1280,height:900}}),errors:string[]=[];
 await context.addInitScript(at=>{Date.now=()=>at;},provider.state.origin);
 const page=await context.newPage(),origin=new URL(base).origin;
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===origin&&u.pathname==='/v1/slack/install') {
   const response=await route.fetch({maxRedirects:0});const authorize=new URL(response.headers().location);
   assert.equal(authorize.origin+authorize.pathname,'https://slack.com/oauth/v2/authorize');
   return route.fulfill({status:302,headers:{Location:`${origin}/v1/slack/oauth/callback?code=synthetic-code&state=${authorize.searchParams.get('state')}`}});
  }
  if(u.origin===origin)return route.continue();
  errors.push(`Blocked browser egress: ${u.origin}${u.pathname}`); console.error(errors.at(-1)); await route.abort();
 });
 const wait=async(label:string,check:()=>Promise<boolean>)=>{const end=Date.now()+45000;while(!await check()){if(Date.now()>end)throw Error(`Timed out: ${label}`);await sleep(100);}};
 const api=async(path:string,method='GET',data?:unknown,expected:number|null=200)=>{
  const r=await page.evaluate(async({url,method,data})=>{const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,body:await response.json()};},{url:`${origin}/v1/${path}`,method,data});
  if(expected===null)return r;
  assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(r.body)}`);return r.body;
 };
 const submit=async(name:string,values:Record<string,string>)=>{
  const form=page.getByRole('form',{name,exact:true});for(const [label,value] of Object.entries(values))await form.getByLabel(label,{exact:true}).fill(value);
  await form.getByRole('button',{name,exact:true}).click();
 };
 try{
  await page.goto(`${base}workspace`);await page.getByLabel('교수 이메일',{exact:true}).fill(identity.email);await page.getByRole('button',{name:'인증 코드 받기',exact:true}).click();
  await wait('synthetic email',async()=>Boolean(provider.state.code));await page.getByLabel('인증 코드 6자리',{exact:true}).fill(provider.state.code);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.getByRole('heading',{name:'교수 워크스페이스',exact:true}).waitFor();assert.equal((await context.cookies()).some(c=>c.name==='__Host-teamplanet_session'&&c.secure&&c.httpOnly),true);
  console.log('PASS built Astro/login UI -> private service binding -> OTP mail adapter -> hardened session');
  await page.getByRole('link',{name:'Slack 연결·권한 다시 설정',exact:true}).click();await page.getByText('연결됨 · 합성 워크스페이스',{exact:true}).waitFor();
  await submit('수업 만들기',{'수업 이름':'합성 E2E 수업'});await page.getByLabel('승인된 동의서 버전',{exact:true}).waitFor();
  const course:any=await db.prepare('SELECT * FROM courses WHERE professor_id=?').bind(identity.professor).first();
  await submit('동의서·수업 기간 저장',{'승인된 동의서 버전':'e2e-form-v1','실제 수업 시작 시각 (UTC ISO 형식)':new Date(provider.state.origin-86400000).toISOString(),'실제 수업 종료 시각 (UTC ISO 형식)':new Date(provider.state.origin+60*86400000).toISOString()});
  await page.getByText(/운영자 승인 버전/).waitFor();await page.getByRole('group',{name:'분석에 사용할 역량',exact:true}).getByRole('checkbox').first().check();await page.getByRole('button',{name:'분석 역량 저장',exact:true}).click();
  await wait('rubric',async()=>Boolean(await db.prepare('SELECT 1 FROM course_rubric_settings WHERE course_id=?').bind(course.id).first()));
  await submit('팀·공식 채널 등록',{'팀 이름':'합성 E2E 팀'});await page.getByRole('heading',{name:'5. 수집 상태와 활성화',exact:true}).waitFor();
  const team:any=await db.prepare('SELECT * FROM teams WHERE course_id=?').bind(course.id).first();await api(`teams/${team.id}/activate`,'POST',{},409);
  await submit('학생 등록',{'학생 표시명':'합성 E2E 학생'});await page.getByRole('heading',{name:'합성 E2E 학생',exact:true}).waitFor();
  const student:any=await db.prepare('SELECT * FROM students WHERE course_id=?').bind(course.id).first();
  await submit('Slack 계정 매핑',{'합성 E2E 학생의 Slack 사용자 ID':identity.user});await submit('오프라인 동의 확보 기록',{'합성 E2E 학생의 동의서 증빙 참조':'synthetic-paper-reference'});
  await page.getByRole('checkbox',{name:/교수가 합성 E2E 학생 본인/}).check();await page.getByRole('button',{name:'학생 개인 QR 발급',exact:true}).click();
  const link=page.getByRole('link',{name:'학생 재확인 페이지 열기',exact:true});await link.waitFor();const personal=await link.getAttribute('href');assert.ok(personal);
  assert.equal(await page.getByRole('button',{name:'수집 활성화 요청',exact:true}).isDisabled(),true);
  const anonymous=await browser.newContext();await anonymous.addInitScript(at=>{Date.now=()=>at;},provider.state.origin);
  const studentPage=await anonymous.newPage();await studentPage.goto(personal!);await studentPage.getByRole('checkbox').check();await studentPage.getByRole('button',{name:'동의서 재확인 제출',exact:true}).click();await studentPage.getByText(/재확인을 기록했습니다/).waitFor();
  assert.equal((await studentPage.request.get(`${origin}/v1/courses`)).status(),401);
  await page.getByRole('button',{name:'최신 상태 다시 조회',exact:true}).click();await page.getByRole('button',{name:'수집 활성화 요청',exact:true}).click();
  await wait('activated',async()=>(await db.prepare('SELECT collection_status FROM teams WHERE id=?').bind(team.id).first<any>())?.collection_status==='active');
  assert.equal(provider.state.modelCalls.length,0);provider.state.enabled=true;provider.state.now+=120000;
  console.log('PASS OAuth/state, course/team/student/mapping/offline consent + personal QR, pre-consent rejection');
  await page.getByLabel('접수 후 답변 기한·자동 삭제 일수 n',{exact:true}).fill('2');await page.getByRole('button',{name:'문의 기한 저장',exact:true}).click();
  await studentPage.getByRole('link',{name:'본인 웹 문의·답변',exact:true}).click();await studentPage.getByLabel('문의 내용',{exact:true}).fill('합성 문의: 피드백 전달 방법을 확인합니다.');await studentPage.getByRole('button',{name:'문의 접수',exact:true}).click();await studentPage.getByText(/접수했습니다/).waitFor();
  await page.getByRole('button',{name:'최신 문의 조회',exact:true}).click();await page.getByLabel('답변',{exact:true}).fill('합성 답변: 최신 리포트로 안내합니다.');await page.getByRole('button',{name:'답변 저장',exact:true}).click();await studentPage.getByRole('button',{name:'최신 상태 조회',exact:true}).click();await studentPage.getByText(/합성 답변: 최신 리포트로 안내합니다/).waitFor();await anonymous.close();
  await page.getByRole('link',{name:'팀 분석',exact:true}).click();await page.getByLabel('시작 시각',{exact:true}).fill(seoulMinute(periodFrom));await page.getByLabel('종료 시각',{exact:true}).fill(seoulMinute(periodTo));await page.getByRole('button',{name:'기간 프리뷰 확인',exact:true}).click();await page.getByRole('button',{name:'기간 대화 확인',exact:true}).click();
  await wait('history coverage',async()=>Boolean(await db.prepare("SELECT 1 FROM collection_coverage WHERE team_id=? AND status='complete'").bind(team.id).first()));
  await page.getByRole('button',{name:'이 기간 분석 실행',exact:true}).click();await wait('A/B/C Queue',async()=>Boolean(await db.prepare("SELECT 1 FROM analysis_runs WHERE team_id=? AND status='awaiting_professor'").bind(team.id).first()));
  await page.getByRole('heading',{name:'결과와 원문 근거',exact:true}).waitFor();const run:any=await db.prepare('SELECT id FROM analysis_runs WHERE team_id=?').bind(team.id).first();const artifacts=await api(`analysis-runs/${run.id}/artifacts`);assert.equal(artifacts.candidate.assessments.length,1);assert.ok(provider.state.imageCalls>0);
  await page.getByRole('button',{name:'근거 1 확인',exact:true}).click();await page.getByRole('button',{name:'원문·스레드 문맥 1',exact:true}).click();await page.locator('.result-context article').first().waitFor();
  await page.getByLabel('검토·변경 사유',{exact:true}).fill('합성 원문·반례·한계를 확인했습니다.');await page.locator('.professor-finalization input[type=checkbox]').check();await page.getByRole('button',{name:'교수 판단 확정',exact:true}).click();await page.getByText(/교수 확인 완료/).first().waitFor();
  const printLink=page.getByRole('link',{name:'이 학생 리포트 미리보기',exact:true});await printLink.waitFor();const reportPage=await context.newPage();await reportPage.goto(origin+(await printLink.getAttribute('href'))!);await reportPage.locator('.report-document').waitFor();await reportPage.getByRole('checkbox').check();await reportPage.evaluate(()=>{window.print=()=>{};});await reportPage.getByRole('button',{name:'원문 재검증 후 인쇄·PDF 저장',exact:true}).click();await reportPage.locator('.print-authorized .report-document').waitFor();await reportPage.pdf({path:join(dir,'synthetic-report.pdf'),format:'A4',preferCSSPageSize:true});assert.equal(await reportPage.locator('.report-document').count(),0);await reportPage.close();
  console.log('PASS History -> native Queue -> A/B/C with image -> source review -> professor finalization -> verified PDF');
  await restart();
  const original=await api(`analysis-runs/${run.id}/assessments`);assert.equal(original.status,'finalized');
  await api(`courses/${course.id}/rubric`,'PUT',{rubricVersion:'communication-v1',selectedCompetencies:['clarity','information_sharing','feedback_alignment','decision_execution']});
  provider.state.correction=true;
  const range={teamId:team.id,from:periodFrom,to:periodTo,timezone:'Asia/Seoul'};
  const next=await api('analysis-runs','POST',{...range,idempotencyKey:crypto.randomUUID()},202);
  await wait('four competencies and correction loop',async()=>(await db.prepare('SELECT status FROM analysis_runs WHERE id=?').bind(next.id).first<any>())?.status==='awaiting_professor');
  const multi=await api(`analysis-runs/${next.id}/assessments`);assert.equal(multi.artifacts.candidate.assessments.length,4);assert.ok(multi.artifacts.correction);
  const finalRequest={requestId:crypto.randomUUID(),expectedRunVersion:multi.version,artifactHash:multi.artifactHash,
   decisions:multi.artifacts.candidate.assessments.map((r:any)=>({studentId:r.studentId,key:r.key,judgement:r.judgement,narrative:r.narrative,reason:'합성 근거·한계·이견을 확인했습니다.'})),
   reviewedStudentIds:[student.id],reviewedEvidenceIds:multi.artifacts.evidence.map((e:any)=>e.id),reviewedIssueIds:['issue_scope'],limitationsReviewed:true,finalDecisionConfirmed:true};
  await api(`analysis-runs/${next.id}/finalize`,'POST',{...finalRequest,reviewedEvidenceIds:[]},409);
  const races=await Promise.all([api(`analysis-runs/${next.id}/finalize`,'POST',finalRequest,null),
   api(`analysis-runs/${next.id}/finalize`,'POST',{...finalRequest,requestId:crypto.randomUUID()},null)]);
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);assert.equal((await api(`analysis-runs/${next.id}/reports/${student.id}`)).cards.length,4);
  assert.equal((await api(`analysis-runs/${run.id}/assessments`)).artifacts.snapshot.rubric.selectedCompetencies.length,1);
  console.log('PASS persisted session/results after Worker reload, explicit four dimensions, one correction, version preservation and finalization conflict');
  provider.state.correction=false;provider.state.modelStatus=402;
  const billed=await api('analysis-runs','POST',{...range,idempotencyKey:crypto.randomUUID()},202);
  await wait('provider 402 block',async()=>(await db.prepare('SELECT status FROM analysis_runs WHERE id=?').bind(billed.id).first<any>())?.status==='blocked_provider_billing');
  await wait('402 queue quarantine',async()=>Boolean(await db.prepare("SELECT 1 FROM queue_jobs WHERE json_extract(job_json,'$.runId')=? AND status='dead'").bind(billed.id).first()));
  assert.equal((await api(`analysis-runs/${billed.id}`)).errors.some((e:any)=>e.code==='PROVIDER_BILLING_BLOCKED'),true);
  provider.state.modelStatus=0;await api(`analysis-runs/${billed.id}/resume`,'POST',{},202);
  await wait('explicit provider recovery',async()=>(await db.prepare('SELECT status FROM analysis_runs WHERE id=?').bind(billed.id).first<any>())?.status==='awaiting_professor');
  provider.state.modelStatus=429;
  const limited=await api('analysis-runs','POST',{...range,idempotencyKey:crypto.randomUUID()},202);
  await wait('429 distinct from billing',async()=>(await db.prepare('SELECT status FROM analysis_runs WHERE id=?').bind(limited.id).first<any>())?.status==='rate_limited');
  await wait('429 queue retry scheduled',async()=>Boolean(await db.prepare("SELECT 1 FROM queue_jobs WHERE json_extract(job_json,'$.runId')=? AND status='retry'").bind(limited.id).first()));
  assert.equal((await api(`analysis-runs/${limited.id}`)).errors.some((e:any)=>e.code==='PROVIDER_BILLING_BLOCKED'),false);
  provider.state.modelStatus=0;provider.state.now+=10000;
  await wait('429 delayed recovery',async()=>(await db.prepare('SELECT status FROM analysis_runs WHERE id=?').bind(limited.id).first<any>())?.status==='awaiting_professor');
  console.log('PASS actual 402 manual resume and 429 technical retry retain their distinct states');
  provider.state.outage=true;await api(`analysis-runs/${run.id}/assessments`,'GET',undefined,503);provider.state.outage=false;
  provider.state.edited=true;await api(`analysis-runs/${run.id}/reports/${student.id}`,'GET',undefined,409);
  assert.equal((await api(`analysis-runs/${run.id}`)).status,'failed_data');
  await api(`teams/${team.id}/consents/${student.id}`,'PUT',{status:'withdrawn',version:'e2e-form-v1',evidenceRef:'synthetic-withdrawal'});
  const calls=provider.state.modelCalls.length;await api('analysis-runs','POST',{...range,idempotencyKey:crypto.randomUUID()},409);
  assert.equal(provider.state.modelCalls.length,calls);
  await api('auth/logout','POST',{});await page.goto(`${origin}/login`);
  const mails=provider.state.mailCount;await page.getByLabel('교수 이메일',{exact:true}).fill(identity.otherEmail);await page.getByRole('button',{name:'인증 코드 받기',exact:true}).click();
  await wait('second professor email',async()=>provider.state.mailCount>mails);await page.getByLabel('인증 코드 6자리',{exact:true}).fill(provider.state.code);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.getByRole('heading',{name:'교수 워크스페이스',exact:true}).waitFor();
  assert.equal((await api('auth/me')).professor.id,identity.otherProfessor);
  await api(`analysis-runs/${run.id}/assessments`,'GET',undefined,404);await api(`analysis-runs/${run.id}/reports/${student.id}`,'GET',undefined,404);
  await api(`analysis-runs/${run.id}/finalize`,'POST',finalRequest,404);
  const cookie=(await context.cookies()).map(c=>`${c.name}=${c.value}`).join('; ');
  assert.equal((await fetch(`${origin}/v1/analysis-runs`,{method:'POST',headers:{Origin:'https://foreign.invalid',Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(`${origin}/v1/slack/events`,{method:'POST',headers:{'Content-Type':'application/json','X-Slack-Request-Timestamp':String(provider.state.now/1000),'X-Slack-Signature':'v0='+'0'.repeat(64)},body:'{}'})).status,401);
  console.log('PASS distinct real professor sessions, foreign resource IDs/CSRF/signature rejection');
  for(const table of ['message_refs','analysis_sources','analysis_stage_results','analysis_outputs','analysis_calls','queue_jobs','job_failures','audit_events','professor_finalizations']){
   const dump=JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results);assert.equal(dump.includes(provider.text),false,`raw source in ${table}`);assert.equal(dump.includes('data:image/'),false);assert.equal(dump.includes(bindings.OPENROUTER_API_KEY),false);
  }
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  console.log('PASS Slack outage != deletion, finalized source invalidation, withdrawal blocks later model transmission, no raw/secret persistence');
  assert.deepEqual(errors,[]);
 }catch(error){console.error('Synthetic browser failure at',page.url());console.error((await page.locator('[role=alert]').allTextContents()).join(' | '));
  console.error(JSON.stringify({jobs:(await db.prepare('SELECT job_key,status,error_code,dispatches,attempts,dispatch_at,available_at FROM queue_jobs').all()).results,deliveries:(await db.prepare('SELECT COUNT(*) AS n FROM e2e_deliveries').all()).results,coverage:(await db.prepare('SELECT status,reason FROM collection_coverage').all()).results,egress:provider.state.unexpected,now:provider.state.now}));throw error;}
 finally{await context.close();}
}
