(function(){
  const SESSION_KEY='haAuthSession';
  const USER_KEY='haAuthUser';
  const publicLinks=[
    {label:'Pricing',href:'/pricing.html',match:['/pricing','/pricing.html']},
    {label:'Coming Soon',href:'/coming-soon',match:['/coming-soon','/coming-soon.html']},
    {label:'FAQ',href:'/faq.html',match:['/faq','/faq.html']},
    {label:'Security',href:'/security.html',match:['/security','/security.html']},
    {label:'Feedback',href:'/contact.html',match:['/feedback','/contact','/contact.html']}
  ];
  const appLinks=[
    {label:'Dashboard',href:'/dashboard/',match:['/dashboard','/dashboard/']},
    {label:'Prospects',href:'/prospects/',match:['/prospects','/prospects/']},
    {label:'Export Guides',href:'/export-guides/',match:['/export-guides','/export-guides/']},
    {label:'Coming Soon',href:'/coming-soon',match:['/coming-soon','/coming-soon.html']},
    {label:'Feedback',href:'/contact.html',match:['/feedback','/contact','/contact.html']}
  ];
  function read(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
  function currentPath(){let p=location.pathname.replace(/\/+$/,'')||'/';return p}
  function isActive(item){const p=currentPath();return item.match.some(m=>{const n=m.replace(/\/+$/,'')||'/';return n==='/'?p==='/':p===n||p.startsWith(n+'/')})}
  function link(item){return `<a class="ha-nav-link${isActive(item)?' is-active':''}" href="${item.href}">${item.label}</a>`}
  function hasSession(){return Boolean(read(SESSION_KEY)?.access_token)}
  function removeLegacy(){
    document.querySelectorAll('body > .beta-top-banner').forEach(el=>el.remove());
    document.querySelectorAll('body > header:not(.ha-ignore-shared-header)').forEach(el=>el.remove());
    document.querySelectorAll('#haAuthNav').forEach(el=>el.remove());
  }
  function render(){
    if(location.pathname.startsWith('/admin')) return;
    removeLegacy();
    const authenticated=hasSession();
    const links=authenticated?appLinks:publicLinks;
    const wrapper=document.createElement('div');
    wrapper.id='haSharedHeader';
    wrapper.innerHTML=`
      <div class="ha-beta-banner">🚧 House Accounts is currently in Beta. Your feedback helps shape what we build next. <a href="/contact.html">Leave Feedback →</a></div>
      <div class="ha-site-header">
        <div class="ha-header-inner">
          <div class="ha-brand"><a class="ha-brand-link" href="${authenticated?'/dashboard/':'/'}">House Accounts</a><span class="ha-product-label">Promo Distributor Tool</span></div>
          <button class="ha-menu-button" type="button" aria-expanded="false" aria-label="Open navigation">☰</button>
          <div class="ha-nav-shell">
            <nav class="ha-nav-links" aria-label="Main navigation">${links.map(link).join('')}</nav>
            <div class="ha-account-actions">
              ${authenticated
                ? `<a class="ha-action-link ha-secondary${isActive({match:['/settings','/settings.html']})?' is-active':''}" href="/settings.html">Settings</a><button class="ha-action-link" type="button" data-ha-logout>Log Out</button>`
                : `<a class="ha-action-link ha-secondary" href="/login">Log In</a><a class="ha-action-link ha-primary" href="/signup">Start Free</a>`}
            </div>
          </div>
          <div class="ha-header-right"><div class="ha-tagline"><strong>Know who to contact and why.</strong><span>The daily intelligence layer for merch professionals.</span></div></div>
        </div>
      </div>`;
    document.body.insertBefore(wrapper,document.body.firstChild);
    const siteHeader=wrapper.querySelector('.ha-site-header');
    const menu=wrapper.querySelector('.ha-menu-button');
    menu.addEventListener('click',()=>{const open=siteHeader.classList.toggle('is-open');menu.setAttribute('aria-expanded',String(open));menu.textContent=open?'✕':'☰'});
    const logout=wrapper.querySelector('[data-ha-logout]');
    if(logout) logout.addEventListener('click',async()=>{
      try{
        const token=read(SESSION_KEY)?.access_token;
        await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({action:'logout'})});
      }catch(e){}
      localStorage.removeItem(SESSION_KEY);localStorage.removeItem(USER_KEY);location.href='/login';
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',render); else render();
})();
