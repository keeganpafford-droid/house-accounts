(function(){
  const SESSION_KEY='haAuthSession';
  const USER_KEY='haAuthUser';

  // Centralized MVP visibility configuration. Hidden features remain implemented
  // and can be restored after MVP without deleting routes, code, or saved data.
  const MVP_FEATURES=Object.freeze({
    houseAccounts:true,
    customerUpload:true,
    settings:true,
    help:true,
    prospectIntelligence:false,
    oneOffResearch:false,
    managementDashboard:false,
    revenueContext:false,
    importGuidesNavigation:false,
    customerSuccessNavigation:false,
    comingSoonNavigation:false,
    betaProgramNavigation:false,
    integrations:false
  });
  window.HouseAccountsMvpFeatures=MVP_FEATURES;
  document.documentElement.classList.add('ha-mvp');

  const publicLinks=[
    {label:'Pricing',href:'/pricing.html',match:['/pricing','/pricing.html']},
    {label:'Customer Success',href:'/success-stories.html',match:['/success-stories','/success-stories.html']},
    {label:'Coming Soon',href:'/coming-soon',match:['/coming-soon','/coming-soon.html']},
    {label:'FAQ',href:'/faq.html',match:['/faq','/faq.html']},
    {label:'Security',href:'/security.html',match:['/security','/security.html']},
    {label:'Feedback',href:'/contact.html',match:['/feedback','/contact','/contact.html']}
  ];

  const appLinks=[
    {label:'House Accounts',href:'/dashboard/',group:'workflow',match:['/dashboard','/dashboard/']},
    {label:'Add Customer Data',href:'/dashboard/#add-customer-data',group:'workflow',match:[]}
  ];

  function read(key){
    try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}
  }

  function currentPath(){
    return location.pathname.replace(/\/+$/,'')||'/';
  }

  function isActive(item){
    const path=currentPath();
    return (item.match||[]).some(match=>{
      const normalized=match.replace(/\/+$/,'')||'/';
      return normalized==='/'?path==='/':path===normalized||path.startsWith(normalized+'/');
    });
  }

  function navLink(item){
    const group=item.group?` ha-nav-${item.group}`:'';
    return `<a class="ha-nav-link${group}${isActive(item)?' is-active':''}" href="${item.href}">${item.label}</a>`;
  }

  function hasSession(){
    return Boolean(read(SESSION_KEY)?.access_token);
  }

  function removeLegacy(){
    document.querySelectorAll([
      'body > .beta-top-banner',
      'body > .beta-banner',
      'body > header:not(.ha-ignore-shared-header)',
      'body > nav.topnav',
      'body > .topnav',
      '#haAuthNav'
    ].join(',')).forEach(el=>el.remove());
  }

  function redirectHiddenMvpRoute(authenticated){
    if(!authenticated) return false;
    const path=currentPath();
    const hiddenRoutes=[
      ['/prospects',MVP_FEATURES.prospectIntelligence],
      ['/prospects/index.html',MVP_FEATURES.prospectIntelligence]
    ];
    const hidden=hiddenRoutes.some(([route,enabled])=>!enabled && (path===route || path.startsWith(route+'/')));
    if(hidden){
      location.replace('/dashboard/?mvp=feature-hidden');
      return true;
    }
    return false;
  }

  function render(){
    if(location.pathname.startsWith('/admin')) return;

    const authenticated=hasSession();
    if(redirectHiddenMvpRoute(authenticated)) return;
    removeLegacy();
    const links=authenticated?appLinks:publicLinks;
    const wrapper=document.createElement('div');
    wrapper.id='haSharedHeader';
    wrapper.innerHTML=`
      <div class="ha-beta-banner">🚧 House Accounts is currently in Beta. Your feedback helps shape what we build next. <a href="/contact.html">Leave Feedback →</a></div>
      <div class="ha-site-header">
        <div class="ha-header-inner">
          <div class="ha-brand-block">
            <a class="ha-brand-link" href="${authenticated?'/dashboard/':'/'}">House Accounts</a>
            <span class="ha-product-label">Promo Distributor Tool</span>
          </div>

          <button class="ha-menu-button" type="button" aria-expanded="false" aria-label="Open navigation">☰</button>

          <div class="ha-nav-shell">
            <nav class="ha-nav-links" aria-label="Main navigation">${links.map(navLink).join('')}</nav>
            <div class="ha-account-actions">
              ${authenticated
                ? `<a class="ha-action-link" href="/contact.html">Help</a><a class="ha-action-link ha-secondary${isActive({match:['/settings','/settings.html']})?' is-active':''}" href="/settings.html">Settings</a><button class="ha-action-link" type="button" data-ha-logout>Sign Out</button>`
                : `<a class="ha-action-link ha-secondary" href="/login">Log In</a><a class="ha-action-link ha-primary" href="/signup">Start Free</a>`}
            </div>
          </div>

          <div class="ha-header-right">
            <div class="ha-tagline">
              <strong>Know who to contact and why.</strong>
              <span>The daily intelligence layer for merch professionals.</span>
            </div>
          </div>
        </div>
      </div>`;

    document.body.insertBefore(wrapper,document.body.firstChild);

    const siteHeader=wrapper.querySelector('.ha-site-header');
    const menu=wrapper.querySelector('.ha-menu-button');
    menu.addEventListener('click',()=>{
      const open=siteHeader.classList.toggle('is-open');
      menu.setAttribute('aria-expanded',String(open));
      menu.textContent=open?'✕':'☰';
    });

    const logout=wrapper.querySelector('[data-ha-logout]');
    if(logout){
      logout.addEventListener('click',async()=>{
        try{
          const token=read(SESSION_KEY)?.access_token;
          await fetch('/api/auth',{
            method:'POST',
            headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
            body:JSON.stringify({action:'logout'})
          });
        }catch(error){}
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(USER_KEY);
        location.href='/login';
      });
    }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',render);
  else render();
})();
