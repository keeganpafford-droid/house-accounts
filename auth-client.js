
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
  // De-duplicates concurrent refresh attempts into ONE in-flight request.
  // Without this, two call sites discovering an expired token around the
  // same time (e.g. requireAuth()'s page-load check racing with an early
  // authHeadersAsync() call from a widget that loads eagerly) would each
  // fire their own /api/auth refresh call using the SAME refresh_token --
  // and Supabase rotates refresh tokens on use, so the second call would
  // race against a refresh_token the first call had already invalidated,
  // causing a spurious session loss. Every caller now awaits the same
  // promise instead.
  let refreshInFlight = null;
  async function refreshIfNeeded(){
    const session=getSession();
    if(!session?.refresh_token) return null;
    const expiresAt = Number(session.expires_at || 0);
    if(expiresAt && Date.now()/1000 < expiresAt - 120) return session;
    if(refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try{ const data = await api('refresh', {refresh_token:session.refresh_token}); return data.session || getSession(); }
      catch(e){ clearAuth(); return null; }
      finally{ refreshInFlight = null; }
    })();
    return refreshInFlight;
  }
  // Idempotent: several call sites can independently discover "the session
  // is truly gone" around the same time (e.g. several protected fetches in
  // flight when a refresh_token finally expires) -- only the first actually
  // navigates, avoiding redundant/racing location.href writes.
  let redirectingToLogin = false;
  function goToLogin(){
    if(redirectingToLogin) return;
    redirectingToLogin = true;
    window.location.href='/login?next='+encodeURIComponent(location.pathname+location.search);
  }
  // Resolves to a session with a genuinely current (or freshly-refreshed)
  // access_token, or null if none is obtainable. Does NOT navigate --
  // callers decide what "no session" means for them (requireAuth() and
  // authHeadersAsync() below both redirect; a caller that wants different
  // behavior, e.g. a silent anonymous fallback, can call this directly).
  async function ensureFreshSession(){
    let session = getSession();
    if(!session?.access_token) return null;
    session = await refreshIfNeeded();
    if(!session?.access_token) return null;
    return session;
  }
  // The async counterpart to authHeaders(): guarantees the token attached
  // is current (refreshing first if it's expired or about to expire, see
  // refreshIfNeeded()'s 120s buffer) rather than whatever happened to be
  // cached in localStorage at call time. Returns null -- never headers with
  // no Authorization key -- when no valid session is obtainable, and
  // redirects to login in that case, so a caller checking `if(!headers)
  // return;` can never accidentally fire a protected request with a stale
  // or missing token.
  async function authHeadersAsync(extra={}){
    const session = await ensureFreshSession();
    if(!session?.access_token){ goToLogin(); return null; }
    return {...extra, Authorization:`Bearer ${session.access_token}`};
  }
  async function requireAuth(){
    const session = await ensureFreshSession();
    if(!session?.access_token) { goToLogin(); return false; }
    try{
      const me = await fetch('/api/auth?action=me', {headers:authHeaders()}).then(async r=>{const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||'Session expired'); return d;});
      if(me.user) writeJson(USER_KEY, me.user);
      return me.user || getUser();
    }catch(e){ clearAuth(); goToLogin(); return false; }
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
  window.HouseAuth = {api, getSession, getUser, token, authHeaders, authHeadersAsync, ensureFreshSession, requireAuth, redirectIfAuthenticated, logout, firstName, usage, clearAuth};
  document.addEventListener('DOMContentLoaded', async ()=>{
    if(document.documentElement.dataset.protected === 'true') await requireAuth();
    if(document.documentElement.dataset.authPage === 'true') await redirectIfAuthenticated('/dashboard/');
    installHeader();
  });
})();
