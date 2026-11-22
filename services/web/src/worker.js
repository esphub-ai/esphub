const domains=new Set(['esphub.ai','www.esphub.ai','app.esphub.ai']);
export default {
 async fetch(req,env){
   const u=new URL(req.url),local=['localhost','127.0.0.1'].includes(u.hostname);
   if(!local&&!domains.has(u.hostname))return new Response('Unknown host',{status:404});
   if(u.pathname.startsWith('/backend/')){
     if(!local&&u.hostname!=='app.esphub.ai')return new Response('Not found',{status:404});
     u.pathname=u.pathname.slice(8);return env.API.fetch(new Request(u,req));
   }
   if(!local&&/^\/(devices?|account)(\/|$)/.test(u.pathname)&&u.hostname!=='app.esphub.ai'){
     u.hostname='app.esphub.ai';return Response.redirect(u,302)
   }
   let res=await env.ASSETS.fetch(req);
   if(res.status===404&&req.method==='GET'&&!u.pathname.split('/').pop().includes('.')){
     res=await env.ASSETS.fetch(new URL('/index.html',u))
   }
   const out=new Response(res.body,res);
   out.headers.set('Referrer-Policy','no-referrer');
   out.headers.set('X-Content-Type-Options','nosniff');
   out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
   return out
 }
}
