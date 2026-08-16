import fs from 'node:fs';
const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
const fixture = JSON.parse(fs.readFileSync(new URL('../benchmarks/arthur-j-gallagher.json', import.meta.url), 'utf8'));
const options = {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'weekly-monitoring',accounts:[{name:fixture.company,website:fixture.website,industry:fixture.industry,location:fixture.location}]})};
const response = await fetch(`${baseUrl}/api/research-batch`, options);
const data = await response.json().catch(()=>({}));
console.log(JSON.stringify({ok:response.ok,status:response.status,endpoint:'/api/research-batch',result:data},null,2));
if(!response.ok) process.exitCode=1;
