import { deflateSync } from "node:zlib";
export const identity = { professor: "prof_00000000-0000-4000-8000-000000000024", otherProfessor: "prof_00000000-0000-4000-8000-000000000025",
  email: "e2e-professor@example.invalid", otherEmail: "e2e-other@example.invalid", slackTeam: "TSYNTHE2E", bot: "USYNTHE2EBOT", user: "USYNTHE2ESTU", channel: "CSYNTHE2E", app: "ASYNTHE2E" };
export const scopes = "channels:read,channels:manage,channels:history,channels:join,users:read,files:read";
export const bindings = { SLACK_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(24))), SLACK_CLIENT_ID: "synthetic-client",
  SLACK_CLIENT_SECRET: "synthetic-client-secret", SLACK_SIGNING_SECRET: "synthetic-signature", RESEND_API_KEY: "synthetic-mail-key", AUTH_EMAIL_FROM: "e2e@example.invalid",
  OPENROUTER_API_KEY: "synthetic-model-key", OPENROUTER_MODEL_EVIDENCE: "qwen/qwen3.5-9b", OPENROUTER_MODEL_ASSESSOR: "qwen/qwen3.5-9b", OPENROUTER_MODEL_REVIEWER: "qwen/qwen3.5-9b" };
const chunk = (kind: string, bytes: Uint8Array) => {
  const out = new Uint8Array(bytes.length + 12); new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(new TextEncoder().encode(kind),4); out.set(bytes,8); let crc=0xffffffff;
  for(const b of out.subarray(4,-4)){crc^=b;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
  new DataView(out.buffer).setUint32(out.length-4,(crc^0xffffffff)>>>0);return out;
};
const header=new Uint8Array(13);new DataView(header.buffer).setUint32(0,1);new DataView(header.buffer).setUint32(4,1);header[8]=8;header[9]=6;
export const image=new Uint8Array([137,80,78,71,13,10,26,10,...chunk("IHDR",header),...chunk("IDAT",deflateSync(new Uint8Array([0,0,0,0,255]))),...chunk("IEND",new Uint8Array())]);
export function syntheticProvider() {
  // Chromium's cookie expiry uses the real clock, not the injected page Date.now.
  const origin = Math.floor(Date.now() / 60000) * 60000;
  const state = { now: origin, origin, code: "", mailCount: 0, messageAt: origin+10000, enabled: false, edited: false, deleted: false, outage: false,
    missingPage: false, unknownMember: false, modelStatus: 0, modelCalls: [] as string[], imageCalls: 0, receiptCalls: 0, unexpected: [] as string[], correction: false };
  const text = "합성 E2E 원문: 프로젝트 조건을 설명하고 도식의 변경 범위를 공유합니다.";
  const message = () => ({ ts: `${Math.floor(state.messageAt/1000)}.000000`, user: identity.user, text: text+(state.edited?" 수정":""),
    files: [{id:"FSYNTHE2E"}] });
  const file = {id:"FSYNTHE2E",user:identity.user,mimetype:"image/png",size:image.length,updated:1,url_private_download:"https://files.slack.com/files-pri/TSYNTHE2E-FSYNTHE2E/download/image.png"};
  async function send(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if(url.hostname==="synthetic.invalid"&&url.pathname==="/clock")return new Response(String(state.now));
    if(url.hostname==="api.resend.com"&&url.pathname==="/emails") {
      const body:any=await request.json();state.code=/코드: (\d{6})/.exec(body.text)?.[1]??"";state.mailCount++;return Response.json({id:"synthetic-mail"});
    }
    if(url.hostname==="files.slack.com"){state.imageCalls++;return new Response(image,{headers:{"Content-Type":"image/png"}});}
    if(url.hostname==="slack.com"&&url.pathname.startsWith("/api/")) {
      const method=url.pathname.slice(5),params=new URLSearchParams(await request.text());
      if(method==="oauth.v2.access")return Response.json({ok:true,access_token:"xoxb-synthetic-e2e",token_type:"bot",scope:scopes,bot_user_id:identity.bot,app_id:identity.app,
        team:{id:identity.slackTeam,name:"합성 워크스페이스"},enterprise:null,is_enterprise_install:false,authed_user:{id:"USYNTHPROF"}});
      if(method==="auth.test")return Response.json({ok:true,team_id:identity.slackTeam},{headers:{"x-oauth-scopes":scopes}});
      if(method==="conversations.create"||method==="conversations.info")return Response.json({ok:true,channel:{id:identity.channel,name:params.get("name")??"synthetic",is_channel:true,is_member:true,is_private:false,is_archived:false,is_shared:false,is_ext_shared:false}});
      if(method==="conversations.join"||method==="conversations.invite")return Response.json({ok:true});
      if(method==="users.info")return Response.json({ok:true,user:{id:identity.user,team_id:identity.slackTeam,is_bot:false,deleted:false}});
      if(method==="conversations.members")return Response.json({ok:true,members:[identity.bot,identity.user,...(state.unknownMember?["USYNTHNEW"]:[])],response_metadata:{next_cursor:""}});
      if(method==="files.info")return Response.json({ok:true,file});
      if(method==="conversations.history"||method==="conversations.replies") {
        if(state.outage)return Response.json({ok:false,error:"ratelimited"},{status:429,headers:{"Retry-After":"2"}});
        return Response.json({ok:true,messages:state.enabled&&!state.deleted?[message()]:[],has_more:state.missingPage,response_metadata:{next_cursor:""}});
      }
    }
    if(url.hostname==="openrouter.ai") {
      if(url.pathname==="/api/v1/generation"){state.receiptCalls++;return Response.json({data:{id:url.searchParams.get("id"),model:bindings.OPENROUTER_MODEL_EVIDENCE,provider_name:"DeepInfra"}});}
      if(url.pathname==="/api/v1/chat/completions") {
        const body:any=await request.json(),name=body.response_format.json_schema.name;state.modelCalls.push(name);
        if(state.modelStatus)return Response.json({error:{metadata:{limit_source:"openrouter_credits"}}},{status:state.modelStatus,headers:{"Retry-After":"2"}});
        const wire=body.messages[1].content,input=JSON.parse(typeof wire==="string"?wire:wire[0].text);let output:any;
        if(name==="teamplanet_evidence_v1")output={version:input.version,processedPartIds:input.primaryPartIds,limitations:[],events:input.parts.filter((p:any)=>input.primaryPartIds.includes(p.id)).map((p:any)=>({
          messageIds:[p.messageId],actorIds:[p.studentId],summary:p.text?"프로젝트 조건에 관한 설명 발화가 관찰된다.":"공유한 도식의 구성 요소가 보인다.",behaviorTags:input.selection.selectedCompetencies,
          modality:p.text?"text":"image",citations:p.text?[{partId:p.id,start:p.start,end:p.end,quote:p.text}]:[],imageCitations:p.images.map((i:any)=>({partId:p.id,imageId:i.id,observation:"합성 도식의 구성 요소가 보인다.",actorId:i.studentId})),limitations:[],requiresHumanReview:true}))};
        else if(name==="teamplanet_review_v1") {
          const fix=state.correction&&input.iteration===0;
          output={version:input.version,runId:input.runId,iteration:input.iteration,decision:fix?"request_correction":"accept",issues:fix?[{id:"issue_scope",code:"context_missing",studentId:input.students[0].id,competency:input.selection.selectedCompetencies[0],evidenceIds:[input.evidence[0].id],messageIds:input.evidence[0].messageIds,instruction:"관찰 범위의 한계를 명시하세요."}]:[],limitations:[],requiresHumanReview:true};
        } else {
          const assessment={version:input.version,runId:input.runId,overviews:input.students.map((s:any)=>({studentId:s.id,summary:"관찰된 설명 사례를 검토해야 한다.",limitations:["합성 환경"],requiresHumanReview:true})),
            assessments:input.candidates.map((c:any)=>({...c,judgement:c.evidenceIds.length?"observed_strength":"insufficient_evidence",narrative:"관찰 범위에서 설명 발화가 확인된다.",counterEvidenceIds:[],confidence:"low",limitations:["관찰 범위 한계"],requiresHumanReview:true}))};
          output=name==="teamplanet_correction_v1"?{version:input.version,iteration:1,resolvedIssueIds:input.correction.issues.map((i:any)=>i.id),assessment}:assessment;
        }
        return Response.json({id:`gen-e2e-${state.modelCalls.length}`,model:bindings.OPENROUTER_MODEL_EVIDENCE,choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
      }
    }
    state.unexpected.push(`${request.method} ${url.hostname}${url.pathname}`);throw Error("Unrecognized synthetic egress; no external fallback");
  }
  return {state,send,text};
}
