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
    // Priority 3 item 11 (paid-beta sprint): re-enabled. The audit found real,
    // well-built per-platform guides at /export-guides/ with no in-app nav
    // entry to reach them -- the only path in was one small inline link
    // shown solely while the upload dropzone was visible. This was the
    // single biggest cause of "confused about how to get data in."
    importGuidesNavigation:true,
    customerSuccessNavigation:false,
    // Paid-beta-readiness sprint: renamed from comingSoonNavigation, which
    // was defined here but never actually consulted anywhere -- the old
    // /coming-soon page it would have gated was orphaned (self-referencing
    // nav only, no real entry point). Restored as the What's New page
    // (/whats-new.html), now actually wired into the Help dropdown below.
    whatsNewNavigation:true,
    betaProgramNavigation:false,
    integrations:false
  });
  window.HouseAccountsMvpFeatures=MVP_FEATURES;
  document.documentElement.classList.add('ha-mvp');

  const publicLinks=[
    {label:'Pricing',href:'/pricing.html',match:['/pricing','/pricing.html']},
    {label:'FAQ',href:'/faq.html',match:['/faq','/faq.html']},
    {label:'Security',href:'/security.html',match:['/security','/security.html']},
    {label:'Feedback',href:'/contact.html',match:['/feedback','/contact','/contact.html']}
  ];

  // Correction round: "House Accounts" was renamed to "Dashboard" here --
  // the logo/brand link (.ha-brand-link, always "House Accounts") already
  // identifies the product, so the nav item only needs to say where it
  // goes. "Add Customer Data" is no longer a plain nav link -- it is the
  // global teal CTA rendered in the account-actions cluster below, using
  // the single canonical add-data action (see ADD_CUSTOMER_DATA_HREF).
  // Stabilization round: Pricing is restored to the authenticated nav
  // (previously only reachable from the public header) -- it was dropped
  // for authenticated users during an earlier round, which meant a
  // signed-in user had no way back to /pricing.html from inside the app.
  const appLinks=[
    {label:'Dashboard',href:'/dashboard/',group:'workflow',match:['/dashboard','/dashboard/']},
    {label:'Export Guides',href:'/export-guides/',group:'workflow',match:['/export-guides','/export-guides/']},
    {label:'Pricing',href:'/pricing.html',group:'workflow',match:['/pricing','/pricing.html']}
  ];

  // Single canonical URL+action contract for "Add Customer Data" -- every
  // authenticated entry point (header CTA, Help routes, Export Guides
  // upload links, the guided tour, the post-upload "Upload Another List"
  // action) must resolve to this exact destination so the dashboard only
  // ever has one code path that opens the upload modal.
  const ADD_CUSTOMER_DATA_HREF='/dashboard/?action=add-data';

  // Minimal authenticated application footer -- product pages only, never
  // injected for signed-out visitors (those keep whatever static marketing
  // footer the page already has). Deliberately does not repeat the header
  // nav; only real, existing destinations. Stabilization round: Pricing and
  // Data Security were missing from this list (both real, existing pages)
  // -- restored so the footer covers the same trust/legal routes the old
  // per-page static footers used to.
  const footerLinks=[
    {label:'Pricing',href:'/pricing.html'},
    {label:'Export Guides',href:'/export-guides/'},
    {label:'Upload Troubleshooting',href:'/export-guides/#troubleshooting'},
    {label:'Data Security',href:'/security.html'},
    {label:'Privacy',href:'/privacy.html'},
    {label:'Terms',href:'/terms.html'},
    {label:'Contact / Feedback',href:'/contact.html'}
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

  function removeLegacy(includeFooter){
    const selectors=[
      'body > .beta-top-banner',
      'body > .beta-banner',
      'body > header:not(.ha-ignore-shared-header)',
      'body > nav.topnav',
      'body > .topnav',
      '#haAuthNav'
    ];
    // The static per-page marketing-style footer (Pricing/FAQ/Security/...)
    // is only removed once we know we are about to replace it with the
    // standardized authenticated application footer -- signed-out visitors
    // keep the existing static footer untouched.
    if(includeFooter) selectors.push('body > footer:not(.ha-ignore-shared-footer)');
    document.querySelectorAll(selectors.join(',')).forEach(el=>el.remove());
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
                ? `<div class="ha-help-menu">
                    <button class="ha-action-link" type="button" id="haHelpToggle" aria-haspopup="true" aria-expanded="false">Help</button>
                    <div class="ha-help-dropdown" id="haHelpDropdown" role="menu" aria-label="Help" hidden>
                      <a role="menuitem" href="/dashboard/#restart-tour">Restart Product Tour</a>
                      <a role="menuitem" href="/export-guides/#need-help">Export Help</a>
                      <a role="menuitem" href="/export-guides/#troubleshooting">Upload Troubleshooting</a>
                      ${MVP_FEATURES.whatsNewNavigation ? `<a role="menuitem" href="/whats-new.html">What's New</a>` : ''}
                      <a role="menuitem" href="/contact.html">Contact / Feedback</a>
                    </div>
                   </div><a class="ha-action-link ha-cta" id="haAddCustomerDataCta" href="${ADD_CUSTOMER_DATA_HREF}">Add Customer Data</a><a class="ha-action-link ha-secondary${isActive({match:['/settings','/settings.html']})?' is-active':''}" href="/settings.html">Settings</a><button class="ha-action-link" type="button" data-ha-logout>Sign Out</button>`
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

    if(authenticated){
      removeLegacy(true);
      const existingFooter=document.getElementById('haSharedFooter');
      if(!existingFooter){
        const footer=document.createElement('footer');
        footer.id='haSharedFooter';
        footer.className='ha-site-footer';
        footer.innerHTML=`<div class="ha-site-footer-links">${footerLinks.map(l=>`<a href="${l.href}">${l.label}</a>`).join('')}</div>`;
        document.body.appendChild(footer);
      }
    }

    const siteHeader=wrapper.querySelector('.ha-site-header');
    const menu=wrapper.querySelector('.ha-menu-button');
    const closeMobileNav=()=>{
      siteHeader.classList.remove('is-open');
      menu.setAttribute('aria-expanded','false');
      menu.textContent='☰';
    };
    menu.addEventListener('click',()=>{
      const open=siteHeader.classList.toggle('is-open');
      menu.setAttribute('aria-expanded',String(open));
      menu.textContent=open?'✕':'☰';
    });

    const helpToggle=wrapper.querySelector('#haHelpToggle');
    const helpDropdown=wrapper.querySelector('#haHelpDropdown');
    // blurToggle is true only when an overlay elsewhere on the page is
    // about to take focus (see closeMenus() below) -- a focused-but-hidden
    // Help button has no visible effect on its own (there is no
    // :focus-within rule keeping the dropdown painted), but explicitly
    // blurring it here means focus is never left dangling on a control
    // that is about to be visually and functionally superseded by a modal.
    const closeHelp=(blurToggle)=>{
      if(!helpToggle||!helpDropdown) return;
      helpDropdown.hidden=true;
      helpToggle.setAttribute('aria-expanded','false');
      if(blurToggle && typeof helpToggle.blur==='function') helpToggle.blur();
    };
    if(helpToggle && helpDropdown){
      helpToggle.addEventListener('click',e=>{
        e.stopPropagation();
        const open=helpDropdown.hidden;
        helpDropdown.hidden=!open;
        helpToggle.setAttribute('aria-expanded',String(open));
        if(open){
          const first=helpDropdown.querySelector('a');
          if(first) first.focus();
        }
      });
      // Dropdown items are same-document hash/anchor links to /dashboard/ --
      // when already on that page, clicking one changes the hash without a
      // full reload, so the dropdown must be closed explicitly rather than
      // relying on navigation to tear it down.
      helpDropdown.querySelectorAll('a').forEach(a=>a.addEventListener('click',closeHelp));
      document.addEventListener('click',e=>{
        if(!helpDropdown.hidden && !helpDropdown.contains(e.target) && e.target!==helpToggle) closeHelp();
      });
      document.addEventListener('keydown',e=>{
        if(e.key==='Escape' && !helpDropdown.hidden){ closeHelp(); helpToggle.focus(); }
      });
    }

    // Follow-up round: per-call-site closeMenus() additions (still called
    // below, unchanged) were necessary but not sufficient -- Preview QA
    // still found Help visible behind the Welcome modal and Add Customer
    // Data. JS-timing/event-order races (a click that opens an overlay
    // arriving in a different tick than the closeMenus() call, a menu
    // reopened by a later handler on the same event, etc.) can still win
    // the race against a one-shot imperative close. A global, counted
    // overlay-open state plus a CSS rule that forces the dropdown hidden
    // whenever ANY overlay is open removes the dependency on event
    // ordering entirely -- the dropdown cannot be visibly open while
    // body.ha-overlay-open is set, full stop, regardless of what sequence
    // of clicks/timeouts got it into that state.
    //
    // A counter (not a boolean) supports nested/overlapping overlays --
    // e.g. a destructive-confirm dialog opened from within the still-open
    // Manage Customer Accounts modal -- so the class is only removed once
    // every open overlay has closed, not the first time any one of them
    // does.
    let overlayDepth=0;
    const beginOverlay=()=>{
      overlayDepth+=1;
      closeHelp(true);
      closeMobileNav();
      document.body.classList.add('ha-overlay-open');
    };
    const endOverlay=()=>{
      overlayDepth=Math.max(0,overlayDepth-1);
      if(overlayDepth===0) document.body.classList.remove('ha-overlay-open');
    };

    // Exposed so other scripts on the page (the dashboard's Welcome modal,
    // guided tour, Add Customer Data modal, Manage Customer Accounts modal,
    // Prepare for Call panel, and the branded confirm/info dialogs) can
    // close every open header menu before presenting their own overlay,
    // and participate in the shared overlay-open state above. closeMenus()
    // is kept for any caller that only wants the one-shot close (no
    // counted overlay state) -- beginOverlay()/endOverlay() are the pair
    // every real overlay open/close should call instead.
    window.HouseAccountsHeader={
      closeMenus(){
        closeHelp(true);
        closeMobileNav();
      },
      beginOverlay,
      endOverlay
    };

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
