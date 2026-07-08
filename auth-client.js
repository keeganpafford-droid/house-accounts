
(function(){
  const SESSION_KEY = 'haAuthSession';
  const USER_KEY = 'haAuthUser';

  function readJson(key){ try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null} }
  function writeJson(key,value){ localStorage.setItem(key, JSON.stringify(value)); }
  function clearAuth(){ localStorage.removeItem(SESSION_KEY); localStorage.removeItem(USER_KEY); }
  function getSession(){ return readJson(SESSION_KEY); }
  function getUser(){ return readJson(USER_KEY); }
  function token(){ return getSession()?.access_token || ''; }
  function authHeaders(extra={}){ const t=token(); return {...extra, ...(t?{Authorization:`Bearer ${t}`}:{})}; }
  async function api(action, payload={}){
    const res = await fetch('/api/auth', {method:'POST', headers:authHeaders({'Content-Type':'application/json'}), body:JSON.stringify({action, ...payload})});
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || 'Authentication request failed.');
    if(data.session) writeJson(SESSION_KEY, data.session);
    if(data.user) writeJson(USER_KEY, data.user);
    return data;
  }
  async function refreshIfNeeded(){
    const session=getSession();
    if(!session?.refresh_token) return null;
    const expiresAt = Number(session.expires_at || 0);
    if(expiresAt && Date.now()/1000 < expiresAt - 120) return session;
    try{ const data = await api('refresh', {refresh_token:session.refresh_token}); return data.session || getSession(); }
    catch(e){ clearAuth(); return null; }
  }
  async function requireAuth(){
    let session = getSession();
    if(!session?.access_token) { window.location.href='/login?next='+encodeURIComponent(location.pathname+location.search); return false; }
    session = await refreshIfNeeded();
    if(!session?.access_token) { window.location.href='/login?next='+encodeURIComponent(location.pathname+location.search); return false; }
    try{
      const me = await fetch('/api/auth?action=me', {headers:authHeaders()}).then(async r=>{const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||'Session expired'); return d;});
      if(me.user) writeJson(USER_KEY, me.user);
      return me.user || getUser();
    }catch(e){ clearAuth(); window.location.href='/login?next='+encodeURIComponent(location.pathname+location.search); return false; }
  }

  async function redirectIfAuthenticated(defaultTarget='/dashboard/'){
    let session = getSession();
    if(session?.access_token) session = await refreshIfNeeded();
    if(session?.access_token) { window.location.href = defaultTarget; return true; }
    return false;
  }

  async function logout(){ try{ await api('logout', {}); }catch(e){} clearAuth(); window.location.href='/login'; }
  function firstName(){ const u=getUser(); return (u?.name||u?.email||'').split(/\s|@/)[0] || ''; }
  async function usage(){
    const res=await fetch('/api/usage', {headers:authHeaders()});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'Could not load usage.');
    return data;
  }
  function installHeader(){
    const u=getUser();
    const nav=document.querySelector('.site-nav') || document.querySelector('.site-header-inner') || document.querySelector('header');
    if(!nav || document.getElementById('haAuthNav')) return;
    const wrap=document.createElement('span'); wrap.id='haAuthNav'; wrap.style.marginLeft='16px'; wrap.style.display='inline-flex'; wrap.style.gap='12px'; wrap.style.alignItems='center';
    if(u?.email){ wrap.innerHTML=`<a href="/settings.html">Settings</a><button type="button" id="haLogoutBtn" style="border:0;background:transparent;color:#17375E;font-weight:700;cursor:pointer">Log out</button>`; }
    else { wrap.innerHTML=`<a href="/login">Log in</a>`; }
    nav.appendChild(wrap);
    const btn=document.getElementById('haLogoutBtn'); if(btn) btn.addEventListener('click', logout);
  }
  window.HouseAuth = {api, getSession, getUser, token, authHeaders, requireAuth, redirectIfAuthenticated, logout, firstName, usage, clearAuth};
  document.addEventListener('DOMContentLoaded', async ()=>{
    if(document.documentElement.dataset.protected === 'true') await requireAuth();
    if(document.documentElement.dataset.authPage === 'true') await redirectIfAuthenticated('/dashboard/');
    installHeader();
  });
})();
