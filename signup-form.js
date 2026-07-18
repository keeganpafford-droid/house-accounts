(function(){
  const form=document.getElementById('signupForm');
  if(!form) return;
  const submit=document.getElementById('signupSubmit');
  const message=document.getElementById('signupMessage');
  const next=new URLSearchParams(location.search).get('next')||'/dashboard/';

  function value(name){
    const field=form.elements.namedItem(name);
    return field && typeof field.value==='string' ? field.value.trim() : '';
  }
  function setError(name,text){
    const field=form.elements.namedItem(name);
    const wrapper=field?.closest('.auth-field');
    if(!wrapper) return;
    wrapper.classList.toggle('has-error',Boolean(text));
    const target=wrapper.querySelector('.auth-error');
    if(target) target.textContent=text||'';
  }
  function clearErrors(){
    form.querySelectorAll('.auth-field').forEach(el=>el.classList.remove('has-error'));
    form.querySelectorAll('.auth-error').forEach(el=>el.textContent='');
    message.className='auth-message'; message.textContent='';
  }
  function show(text,type='error'){
    message.textContent=text;
    message.className='auth-message '+type;
  }
  function validate(){
    clearErrors();
    let valid=true;
    const required={name:'Enter your name.',organizationName:'Enter your company or organization.',role:'Choose your role.',email:'Enter your work email.',password:'Enter a password.'};
    Object.entries(required).forEach(([name,text])=>{if(!value(name)){setError(name,text);valid=false;}});
    const email=value('email');
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setError('email','Enter a valid email address.');valid=false;}
    const count=Number(value('house_accounts'));
    if(!value('house_accounts') || !Number.isFinite(count) || count<=0){setError('house_accounts','Enter a number greater than zero.');valid=false;}
    return valid;
  }

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!validate()) return;
    submit.disabled=true;
    submit.textContent='Creating account…';
    try{
      await HouseAuth.api('signup',{
        name:value('name'),
        organizationName:value('organizationName'),
        role:value('role'),
        house_accounts:value('house_accounts'),
        crm_erp:value('crm_erp'),
        email:value('email').toLowerCase(),
        password:value('password'),
        plan:'free'
      });
      location.href=next;
    }catch(error){
      show(error.message||'We could not create your account. Please try again.');
    }finally{
      submit.disabled=false;
      submit.textContent='Start Free';
    }
  });
})();
