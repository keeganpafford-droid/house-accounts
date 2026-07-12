// House Accounts Admin Dashboard V2 data endpoint.
// GET /api/admin-dashboard. Uses existing Supabase tables only.

function json(res,status,body){return res.status(status).json(body)}
function clean(v=''){return String(v??'').trim()}
function lower(v=''){return clean(v).toLowerCase()}
function env(){
  const rawUrl=clean(process.env.SUPABASE_URL); const key=clean(process.env.SUPABASE_SERVICE_ROLE_KEY); const adminEmail=lower(process.env.ADMIN_EMAIL);
  if(!rawUrl||!key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if(!adminEmail){console.error('[Admin Auth] ADMIN_EMAIL is missing; admin access denied.');const e=new Error('Admin access is not configured.');e.code='ADMIN_EMAIL_MISSING';throw e}
  return{url:rawUrl.replace(/\/+$/,'').replace(/\/rest\/v1$/i,''),key,adminEmail};
}
async function sb(path,options={}){
  const {url,key}=env();
  const r=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:options.prefer||'return=representation',...(options.headers||{})}});
  const text=await r.text(); let data=null; if(text){try{data=JSON.parse(text)}catch{data=text}}
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data==='string'?data:(data?.message||data?.hint||JSON.stringify(data))}`);
  return data;
}
async function maybe(table,order='created_at.desc',limit=10000){
  try{return await sb(`${table}?select=*&order=${order}&limit=${limit}`)}catch(e){
    const m=lower(e.message); if(m.includes('does not exist')||m.includes('schema cache')||m.includes('could not find')) return [];
    // Some tables do not have the requested order column. Retry without ordering.
    try{return await sb(`${table}?select=*&limit=${limit}`)}catch(e2){const m2=lower(e2.message);if(m2.includes('does not exist')||m2.includes('schema cache')||m2.includes('could not find'))return[];throw e2}
  }
}
async function authUser(req){const token=clean(req.headers.authorization).replace(/^Bearer\s+/i,'');if(!token)return null;const{url,key}=env();const r=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});return r.ok?r.json():null}
const ts=v=>{const n=new Date(v||0).getTime();return Number.isFinite(n)&&n>0?n:0};
const iso=v=>ts(v)?new Date(ts(v)).toISOString():'';
const first=(o,keys)=>{for(const k of keys){if(o?.[k]!==undefined&&o?.[k]!==null&&o?.[k]!=='')return o[k]}return''};
const rowDate=r=>first(r,['created_at','first_seen_at','started_at','updated_at','last_seen_at','finished_at','accepted_at']);
const isPaused=r=>['paused','archived','inactive'].includes(lower(first(r,['stage','status','monitoring_status'])));
const startOfWeek=()=>{const d=new Date();const day=d.getUTCDay();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((day+6)%7));return d.getTime()};
const ageDays=v=>ts(v)?Math.floor((Date.now()-ts(v))/86400000):null;
const remaining=v=>ts(v)?Math.ceil((ts(v)-Date.now())/86400000):null;
function pushMap(map,key,row){if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(row)}
function statusRun(r){return lower(first(r,['status','run_status']))}
function loginDate(u){return first(u,['last_login_at','last_login','last_seen_at'])}
function activityStatus(u){const t=ts(loginDate(u));if(!t)return'Never logged in';const days=(Date.now()-t)/86400000;if(days<1)return'Active today';if(days<7)return'Active this week';if(days>=14)return'Inactive 14+ days';return'Inactive';}
function orgIdForUpload(upload,userById,userByEmail){return userById.get(upload?.user_id)?.organization_id||userByEmail.get(lower(upload?.user_email||upload?.email))?.organization_id||''}
function healthFor(o){
  if(o.failedRuns>0&&o.lastRunStatus==='failed')return'Scan Failed';
  if(Number.isFinite(o.seatLimit)&&o.seatLimit>0&&o.seatsUsed>o.seatLimit)return'Over Seat Limit';
  if(o.trialExpired)return'Trial Expired';
  if(o.trialDaysRemaining!==null&&o.trialDaysRemaining>=0&&o.trialDaysRemaining<=7)return'Trial Expiring';
  if(o.lastLogin&&ageDays(o.lastLogin)>=14)return'Inactive';
  if(!o.lastLogin&&!o.lastUpload)return'No Activity';
  if((o.activeCustomers+o.activeProspects)>0&&!o.lastSuccessfulWeeklyScan)return'Needs Attention';
  return'Healthy';
}

function normalizedDevice(e){return clean(e.device_fingerprint)||lower(clean(e.user_agent)).replace(/\d+(?:\.\d+)+/g,'#').slice(0,180)}
function locationLabel(e){return [e.city,e.region,e.country].filter(Boolean).join(', ')||null}
function browserSummary(ua=''){
  const value=clean(ua);if(!value)return'Unknown browser';
  const browser=(value.match(/Edg\/[\d.]+/)||value.match(/Chrome\/[\d.]+/)||value.match(/Firefox\/[\d.]+/)||value.match(/Version\/[\d.]+.*Safari/)||[])[0]||value.split(' ')[0];
  const os=/Windows/i.test(value)?'Windows':/Android/i.test(value)?'Android':/iPhone|iPad/i.test(value)?'iOS':/Mac OS/i.test(value)?'macOS':/Linux/i.test(value)?'Linux':'';
  return [browser,os].filter(Boolean).join(' · ');
}
function loginRiskFor(events,plan='free'){
  const sorted=[...(events||[])].sort((a,b)=>ts(b.logged_in_at||b.created_at)-ts(a.logged_in_at||a.created_at));
  const now=Date.now(),e24=sorted.filter(e=>now-ts(e.logged_in_at||e.created_at)<=86400000),e7=sorted.filter(e=>now-ts(e.logged_in_at||e.created_at)<=7*86400000);
  const ips24=new Set(e24.map(e=>clean(e.ip_address)).filter(Boolean)),ips7=new Set(e7.map(e=>clean(e.ip_address)).filter(Boolean));
  const dev24=new Set(e24.map(normalizedDevice).filter(Boolean)),dev7=new Set(e7.map(normalizedDevice).filter(Boolean));
  const reasons=[];let level=0;
  if(ips24.size>=5){reasons.push(`${ips24.size} unique IPs in 24 hours`);level=Math.max(level,2)}
  else if(ips7.size>=10){reasons.push(`${ips7.size} unique IPs in 7 days`);level=Math.max(level,2)}
  else if(ips7.size>=5){reasons.push(`${ips7.size} unique IPs in 7 days`);level=Math.max(level,1)}
  if(dev24.size>=4){reasons.push(`${dev24.size} devices in 24 hours`);level=Math.max(level,2)}
  else if(dev7.size>=6){reasons.push(`${dev7.size} devices in 7 days`);level=Math.max(level,1)}
  for(let i=0;i<sorted.length-1;i++){
    const a=sorted[i],b=sorted[i+1],minutes=Math.abs(ts(a.logged_in_at||a.created_at)-ts(b.logged_in_at||b.created_at))/60000;
    if(minutes>60)continue;
    const locA=locationLabel(a),locB=locationLabel(b),differentCountry=a.country&&b.country&&lower(a.country)!==lower(b.country),differentRegion=a.region&&b.region&&lower(a.region)!==lower(b.region);
    if(differentCountry){reasons.push(`Logins from different countries within ${Math.max(1,Math.round(minutes))} minutes`);level=Math.max(level,2);break}
    if(minutes<=15&&differentRegion&&locA&&locB){reasons.push(`Different regions within ${Math.max(1,Math.round(minutes))} minutes`);level=Math.max(level,1);break}
    if(minutes<=15&&clean(a.ip_address)&&clean(b.ip_address)&&a.ip_address!==b.ip_address&&normalizedDevice(a)!==normalizedDevice(b)){reasons.push('Different IPs and devices used within 15 minutes');level=Math.max(level,1);break}
  }
  if(lower(plan)==='solo'&&ips7.size>=3&&dev7.size>=3){reasons.push('Solo plan shows repeated multi-device and multi-IP use');level=Math.max(level,2)}
  return{status:level===2?'possible_shared_login':level===1?'review':'normal',label:level===2?'Possible Shared Login':level===1?'Review':'Normal',reasons:[...new Set(reasons)],uniqueIps24h:ips24.size,uniqueIps7d:ips7.size,uniqueDevices24h:dev24.size,uniqueDevices7d:dev7.size,lastLocation:sorted[0]?locationLabel(sorted[0]):null};
}

export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  try{
    const{adminEmail}=env();const au=await authUser(req);if(!au?.id||!clean(au.email))return json(res,401,{error:'Authentication required'});if(lower(au.email)!==adminEmail)return json(res,403,{error:'Admin access only'});
    const [organizations,users,invitations,uploads,accounts,signals,prospectUploads,prospectAccounts,prospectSignals,weeklyRuns,feedback,monitored,loginEvents]=await Promise.all([
      maybe('ha_organizations'),maybe('ha_users'),maybe('ha_invitations'),maybe('ha_uploads'),maybe('ha_accounts'),maybe('ha_signals','first_seen_at.desc'),maybe('ha_prospect_uploads'),maybe('ha_prospect_accounts'),maybe('ha_prospect_signals'),maybe('ha_weekly_runs','started_at.desc'),maybe('ha_feedback'),maybe('ha_monitored_companies'),maybe('ha_login_events','logged_in_at.desc',50000)
    ]);
    const userById=new Map(users.map(u=>[u.id,u]));const userByEmail=new Map(users.map(u=>[lower(u.email),u]));const orgById=new Map(organizations.map(o=>[o.id,o]));
    const custUploadsByOrg=new Map(),prosUploadsByOrg=new Map(),usersByOrg=new Map(),invitesByOrg=new Map(),runsByOrg=new Map();
    uploads.forEach(r=>pushMap(custUploadsByOrg,orgIdForUpload(r,userById,userByEmail),r));
    prospectUploads.forEach(r=>pushMap(prosUploadsByOrg,orgIdForUpload(r,userById,userByEmail),r));
    users.forEach(r=>pushMap(usersByOrg,r.organization_id,r));invitations.forEach(r=>pushMap(invitesByOrg,r.organization_id,r));
    weeklyRuns.forEach(r=>{const org=userById.get(r.user_id)?.organization_id||orgIdForUpload(uploads.find(u=>u.id===r.upload_id)||{},userById,userByEmail);pushMap(runsByOrg,org,r)});
    const custUploadOrg=new Map(uploads.map(u=>[u.id,orgIdForUpload(u,userById,userByEmail)]));const prosUploadOrg=new Map(prospectUploads.map(u=>[u.id,orgIdForUpload(u,userById,userByEmail)]));
    const custAccountsByOrg=new Map(),prosAccountsByOrg=new Map(),custSignalsByOrg=new Map(),prosSignalsByOrg=new Map();
    accounts.forEach(r=>pushMap(custAccountsByOrg,custUploadOrg.get(r.upload_id)||userById.get(r.user_id)?.organization_id,r));
    prospectAccounts.forEach(r=>pushMap(prosAccountsByOrg,prosUploadOrg.get(r.upload_id),r));
    signals.forEach(r=>pushMap(custSignalsByOrg,custUploadOrg.get(r.upload_id)||userById.get(r.user_id)?.organization_id,r));
    prospectSignals.forEach(r=>pushMap(prosSignalsByOrg,prosUploadOrg.get(r.upload_id)||userByEmail.get(lower(r.user_email))?.organization_id,r));
    const week=startOfWeek();
    const orgRows=organizations.map(org=>{
      const members=usersByOrg.get(org.id)||[],cu=custUploadsByOrg.get(org.id)||[],pu=prosUploadsByOrg.get(org.id)||[],ca=custAccountsByOrg.get(org.id)||[],pa=prosAccountsByOrg.get(org.id)||[],cs=custSignalsByOrg.get(org.id)||[],ps=prosSignalsByOrg.get(org.id)||[],runs=runsByOrg.get(org.id)||[],inv=invitesByOrg.get(org.id)||[];
      const activeCU=new Set(cu.filter(x=>!isPaused(x)).map(x=>x.id)),activePU=new Set(pu.filter(x=>!isPaused(x)).map(x=>x.id));
      const activeCustomers=ca.filter(x=>!isPaused(x)&&(!x.upload_id||activeCU.has(x.upload_id))).length,pausedCustomers=Math.max(0,ca.length-activeCustomers);
      const activeProspects=pa.filter(x=>!isPaused(x)&&(!x.upload_id||activePU.has(x.upload_id))).length,pausedProspects=Math.max(0,pa.length-activeProspects);
      const successful=runs.filter(x=>['complete','completed','success','succeeded','sent'].includes(statusRun(x))),failed=runs.filter(x=>statusRun(x)==='failed');
      const lastLogin=[...members].sort((a,b)=>ts(loginDate(b))-ts(loginDate(a)))[0];
      const lastUpload=[...cu,...pu].sort((a,b)=>ts(rowDate(b))-ts(rowDate(a)))[0];
      const tr=remaining(org.trial_end),trialExpired=lower(org.subscription_status)==='trialing'&&tr!==null&&tr<0;
      const row={id:org.id,name:org.name||'Unnamed organization',plan:org.plan||'free',trialStatus:org.trial_status||'',subscriptionStatus:org.subscription_status||'',trialStartedAt:org.trial_started_at||'',trialEnd:org.trial_end||'',trialUsed:!!org.trial_used,trialDaysRemaining:tr,trialExpired,seatLimit:Number(org.seat_limit||1),seatsUsed:members.filter(x=>lower(x.status||'active')!=='inactive').length,activeUsers:members.filter(x=>lower(x.status||'active')!=='inactive').length,activeCustomers,pausedCustomers,activeProspects,pausedProspects,customerUploads:cu.length,prospectUploads:pu.length,customerSignals:cs.length,prospectSignals:ps.length,signalsThisWeek:[...cs,...ps].filter(x=>ts(rowDate(x))>=week).length,lastLogin:loginDate(lastLogin),lastUpload:rowDate(lastUpload),lastSuccessfulWeeklyScan:rowDate(successful[0]),lastWeeklyRun:rowDate(runs[0]),lastRunStatus:statusRun(runs[0]),failedRuns:failed.length,pendingInvites:inv.filter(x=>lower(x.status)==='pending'&&(!x.expires_at||ts(x.expires_at)>Date.now())).length,expiredInvites:inv.filter(x=>lower(x.status)==='pending'&&x.expires_at&&ts(x.expires_at)<=Date.now()).length,createdAt:org.created_at||'',members,invites:inv,recentActivity:[]};
      row.health=healthFor(row);return row;
    });
    const orgRowById=new Map(orgRows.map(o=>[o.id,o]));
    const loginByUser=new Map(),loginByEmail=new Map(),loginByOrg=new Map();
    loginEvents.forEach(e=>{pushMap(loginByUser,e.user_id,e);pushMap(loginByEmail,lower(e.email),e);pushMap(loginByOrg,e.organization_id,e)});
    const userRows=users.map(u=>{
      const org=orgRowById.get(u.organization_id)||{};const cu=uploads.filter(x=>x.user_id===u.id),pu=prospectUploads.filter(x=>lower(x.user_email)===lower(u.email));const cids=new Set(cu.map(x=>x.id)),pids=new Set(pu.map(x=>x.id));const ca=accounts.filter(x=>cids.has(x.upload_id)),pa=prospectAccounts.filter(x=>pids.has(x.upload_id)),cs=signals.filter(x=>cids.has(x.upload_id)||x.user_id===u.id),ps=prospectSignals.filter(x=>pids.has(x.upload_id)||lower(x.user_email)===lower(u.email));const inv=invitations.filter(x=>lower(x.email)===lower(u.email));
      const userLoginEvents=[...(loginByUser.get(u.id)||[]),...(loginByEmail.get(lower(u.email))||[])].filter((e,i,a)=>a.findIndex(x=>x.id===e.id)===i).sort((a,b)=>ts(b.logged_in_at||b.created_at)-ts(a.logged_in_at||a.created_at));const loginRisk=loginRiskFor(userLoginEvents,org.plan||'free');return{id:u.id,name:u.name||'',email:u.email||'',organizationId:u.organization_id||'',organization:org.name||u.company||'',role:u.app_role||u.role||'member',plan:org.plan||'free',status:u.status||'active',memberSince:u.created_at||'',lastLogin:loginDate(u),lastSeen:u.last_seen_at||'',loginCount:Number(u.login_count||0),lastIp:u.last_ip||'',userAgent:u.user_agent||'',customerUploads:cu.length,prospectUploads:pu.length,uploads:cu.length+pu.length,customerAccounts:ca.length,prospects:pa.length,monitoredCompanies:ca.length+pa.length,signals:cs.length+ps.length,latestActivity:[...cu,...pu,...cs,...ps].sort((a,b)=>ts(rowDate(b))-ts(rowDate(a))).map(rowDate)[0]||'',activityStatus:activityStatus(u),invitations:inv,dashboardUrl:`/?dashboardEmail=${encodeURIComponent(u.email||'')}`,loginRisk,recentLoginEvents:userLoginEvents.slice(0,50).map(e=>({...e,browserSummary:browserSummary(e.user_agent),location:locationLabel(e),deviceShort:clean(e.device_fingerprint).slice(0,10)||''}))};
    });
    const activity=[];const add=(type,orgId,userEmail,description,date,status='')=>{if(date)activity.push({type,organizationId:orgId,organization:orgRowById.get(orgId)?.name||'',userEmail,description,timestamp:date,status})};
    loginEvents.forEach(e=>add('Login',e.organization_id||userById.get(e.user_id)?.organization_id,e.email,`${userById.get(e.user_id)?.name||e.email||'A user'} logged in`,e.logged_in_at||e.created_at));if(!loginEvents.length)users.forEach(u=>{if(loginDate(u))add('Login',u.organization_id,u.email,`${u.name||u.email} logged in`,loginDate(u))});
    uploads.forEach(u=>{const user=userById.get(u.user_id);add('Upload',user?.organization_id,user?.email,`${user?.name||user?.email||'A user'} uploaded ${u.account_count||u.row_count||''} customer accounts`.replace(/\s+/g,' '),rowDate(u))});
    prospectUploads.forEach(u=>{const user=userByEmail.get(lower(u.user_email));add('Prospect research',user?.organization_id,u.user_email,`${user?.name||u.user_email||'A user'} added ${u.account_count||''} prospect accounts`.replace(/\s+/g,' '),rowDate(u))});
    signals.forEach(s=>add('Signal created',custUploadOrg.get(s.upload_id)||userById.get(s.user_id)?.organization_id,userById.get(s.user_id)?.email,`${s.account_name||'Account'}: ${s.title||s.signal_type||'signal'}`,rowDate(s)));
    prospectSignals.forEach(s=>add('Signal created',prosUploadOrg.get(s.upload_id)||userByEmail.get(lower(s.user_email))?.organization_id,s.user_email,`${s.company_name||'Prospect'}: ${s.title||s.signal_type||'signal'}`,rowDate(s)));
    weeklyRuns.forEach(r=>add(statusRun(r)==='failed'?'Weekly run failed':'Weekly run complete',userById.get(r.user_id)?.organization_id,userById.get(r.user_id)?.email,`Weekly run ${statusRun(r)||'completed'}`,rowDate(r),statusRun(r)));
    invitations.forEach(i=>add(lower(i.status)==='accepted'?'Invitation accepted':'Invitation sent',i.organization_id,i.email,lower(i.status)==='accepted'?`${i.email} joined the organization`:`Invitation sent to ${i.email}`,i.accepted_at||i.created_at,i.status));
    activity.sort((a,b)=>ts(b.timestamp)-ts(a.timestamp));
    const needs=[];const attention=(type,org,user,explanation,date,action='')=>needs.push({type,organizationId:org?.id||user?.organizationId||'',organization:org?.name||user?.organization||'',user:user?.name||'',email:user?.email||'',explanation,date,ageDays:ageDays(date),action});
    orgRows.forEach(o=>{if(o.trialExpired)attention('Trial expired',o,null,'Trial has expired.',o.trialEnd);else if(o.trialDaysRemaining!==null&&o.trialDaysRemaining>=0&&o.trialDaysRemaining<=7)attention('Trial expiring',o,null,`Ends in ${o.trialDaysRemaining} days.`,o.trialEnd);if(o.seatsUsed>o.seatLimit)attention('Over seat limit',o,null,`${o.seatsUsed} of ${o.seatLimit} seats are in use.`,o.lastLogin);if(o.failedRuns)attention('Weekly scan failed',o,null,`${o.failedRuns} failed weekly run${o.failedRuns===1?'':'s'}.`,o.lastWeeklyRun);if((o.activeCustomers+o.activeProspects)>0&&!o.lastSuccessfulWeeklyScan)attention('No successful weekly run',o,null,'Monitored accounts exist but no successful weekly run was found.',o.lastUpload);if(o.activeUsers>0&&!o.members.some(m=>['owner','admin'].includes(lower(m.app_role||m.role))&&lower(m.status||'active')!=='inactive'))attention('No active owner/admin',o,null,'Organization has users but no active owner or admin.',o.createdAt);o.invites.filter(i=>lower(i.status)==='pending'&&ageDays(i.created_at)>=3).forEach(i=>attention('Old pending invitation',o,null,`${i.email} has been pending for ${ageDays(i.created_at)} days.`,i.created_at))});
    userRows.forEach(u=>{if(!u.lastLogin)attention('Never activated',orgRowById.get(u.organizationId),u,'Signed up but never logged in.',u.memberSince);else if(u.uploads===0)attention('No uploads',orgRowById.get(u.organizationId),u,'Logged in but has never uploaded data.',u.lastLogin);else if(u.signals===0)attention('No saved signals',orgRowById.get(u.organizationId),u,'Uploaded data but has zero saved signals.',u.latestActivity);if(u.lastLogin&&ageDays(u.lastLogin)>=14)attention('Inactive user',orgRowById.get(u.organizationId),u,`Inactive for ${ageDays(u.lastLogin)} days.`,u.lastLogin);if(u.loginRisk?.status!=='normal')attention(u.loginRisk.status==='possible_shared_login'?'Possible shared login':'Unusual login activity',orgRowById.get(u.organizationId),u,u.loginRisk.reasons.join('; ')||'Login activity should be reviewed.',u.lastLogin)});
    const failedRuns=weeklyRuns.filter(r=>statusRun(r)==='failed'),successfulRuns=weeklyRuns.filter(r=>['complete','completed','success','succeeded','sent'].includes(statusRun(r))),pendingInvites=invitations.filter(i=>lower(i.status)==='pending'&&(!i.expires_at||ts(i.expires_at)>Date.now())),expiredInvites=invitations.filter(i=>lower(i.status)==='pending'&&i.expires_at&&ts(i.expires_at)<=Date.now());
    const activeUsers7=userRows.filter(u=>u.lastLogin&&Date.now()-ts(u.lastLogin)<=7*86400000).length,activeTrials=orgRows.filter(o=>lower(o.trialStatus)==='active'||lower(o.subscriptionStatus)==='trialing').length,expiring=orgRows.filter(o=>o.trialDaysRemaining!==null&&o.trialDaysRemaining>=0&&o.trialDaysRemaining<=7).length;
    orgRows.forEach(o=>{const oe=loginByOrg.get(o.id)||[],flagged=userRows.filter(u=>u.organizationId===o.id&&u.loginRisk?.status!=='normal');o.loginMonitoring={totalUniqueIps:new Set(oe.map(e=>clean(e.ip_address)).filter(Boolean)).size,flaggedUsers:flagged.length,flaggedUserList:flagged.map(u=>({id:u.id,name:u.name,email:u.email,status:u.loginRisk.status,label:u.loginRisk.label,reasons:u.loginRisk.reasons})),recentUnusualEvents:oe.filter(e=>flagged.some(u=>u.id===e.user_id||lower(u.email)===lower(e.email))).slice(0,20).map(e=>({...e,browserSummary:browserSummary(e.user_agent),location:locationLabel(e)}))};});
    const unusualUsers=userRows.filter(u=>u.loginRisk?.status!=='normal'),recentLoginEvents=loginEvents.slice(0,500).map(e=>({...e,browserSummary:browserSummary(e.user_agent),location:locationLabel(e)}));
    const response={overview:{totalOrganizations:orgRows.length,totalBetaUsers:userRows.length,activeUsersLast7Days:activeUsers7,activeTrials,trialsExpiringNext7Days:expiring,totalMonitoredCompanies:orgRows.reduce((n,o)=>n+o.activeCustomers+o.activeProspects,0),signalsCreatedThisWeek:orgRows.reduce((n,o)=>n+o.signalsThisWeek,0),failedWeeklyRuns:failedRuns.length,pendingInvitations:pendingInvites.length},needsAttention:needs.sort((a,b)=>ts(b.date)-ts(a.date)),organizations:orgRows.map(o=>({...o,members:undefined,invites:undefined})),organizationDetails:Object.fromEntries(orgRows.map(o=>[o.id,o])),users:userRows,activity:activity.slice(0,2500),systemHealth:{weeklyScanning:{totalRuns:weeklyRuns.length,successfulRuns:successfulRuns.length,failedRuns:failedRuns.length,successRate:weeklyRuns.length?Math.round(successfulRuns.length/weeklyRuns.length*100):0,lastSuccessfulRun:rowDate(successfulRuns[0]),lastFailedRun:rowDate(failedRuns[0])},researchPipeline:{recentProspectSaves:prospectUploads.slice(0,20),recentCustomerSaves:uploads.slice(0,20)},email:{pendingInvitations:pendingInvites.length,expiredInvitations:expiredInvites.length},authentication:{neverLoggedIn:userRows.filter(u=>!u.lastLogin).length,inactive14Days:userRows.filter(u=>u.lastLogin&&ageDays(u.lastLogin)>=14).length,recentLogins:activity.filter(a=>a.type==='Login').slice(0,20),loginEvents24h:loginEvents.filter(e=>Date.now()-ts(e.logged_in_at||e.created_at)<=86400000).length,loginEvents7d:loginEvents.filter(e=>Date.now()-ts(e.logged_in_at||e.created_at)<=7*86400000).length,usersFlaggedForReview:unusualUsers.length,possibleSharedLogins:unusualUsers.filter(u=>u.loginRisk.status==='possible_shared_login').length},monitoring:{activeLists:uploads.filter(x=>!isPaused(x)).length+prospectUploads.filter(x=>!isPaused(x)).length,pausedLists:uploads.filter(isPaused).length+prospectUploads.filter(isPaused).length,organizationsWithoutRecentScan:orgRows.filter(o=>(o.activeCustomers+o.activeProspects)>0&&!o.lastSuccessfulWeeklyScan)},failedWeeklyRuns:failedRuns.slice(0,100),staleOrganizations:orgRows.filter(o=>o.lastLogin&&ageDays(o.lastLogin)>=14),expiringTrials:orgRows.filter(o=>o.trialDaysRemaining!==null&&o.trialDaysRemaining>=0&&o.trialDaysRemaining<=7),oldPendingInvitations:pendingInvites.filter(i=>ageDays(i.created_at)>=3),unusualLoginUsers:unusualUsers},recentLoginEvents,unusualLoginEvents:recentLoginEvents.filter(e=>unusualUsers.some(u=>u.id===e.user_id||lower(u.email)===lower(e.email))),legacy:{metrics:{totalOrganizations:orgRows.length,totalBetaUsers:userRows.length,totalUploads:uploads.length+prospectUploads.length,totalAccountsAnalyzed:accounts.length+prospectAccounts.length,totalSavedSignals:signals.length+prospectSignals.length,totalWeeklyRuns:weeklyRuns.length,totalPendingInvitations:pendingInvites.length},betaUsers:userRows,recentActivity:{uploads:uploads.slice(0,10),signals:[...signals,...prospectSignals].slice(0,10),weeklyRuns:weeklyRuns.slice(0,10),feedback:feedback.slice(0,10)}}};
    return json(res,200,response);
  }catch(e){if(e.code==='ADMIN_EMAIL_MISSING')return json(res,503,{error:'Admin access is not configured.'});console.error('[Admin Dashboard V2]',e);return json(res,500,{error:e.message||'Admin dashboard failed'})}
}
