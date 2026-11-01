import http from 'node:http';
const requests = [];
const server = http.createServer((req, res) => {
 const u = new URL(req.url, 'http://localhost');
 if (u.pathname === '/data') {
  const record = {url:req.url, at:Date.now(), mode:req.headers['sec-fetch-mode'], destination:req.headers['sec-fetch-dest']};
  requests.push(record);
  setTimeout(() => {res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({sequence:requests.length}));}, Number(u.searchParams.get('network') || 0));
  return;
 }
 if (u.pathname === '/requests') {res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(requests));return;}
 const id = u.searchParams.get('id') || Date.now();
 const delay = Number(u.searchParams.get('delay') || 1000);
 const network = Number(u.searchParams.get('network') || 0);
 const cache = u.searchParams.get('cache') || 'no-store';
 const target = `/data?id=${id}&network=${network}`;
 res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-store'});
 res.end(`<!doctype html><html><head><link rel="preload" as="fetch" href="${target}" crossorigin="anonymous"></head><body>probe<script>window.result=null;setTimeout(async()=>{const response=await fetch(${JSON.stringify(target)},{cache:${JSON.stringify(cache)}});window.result={body:await response.json(),visibility:document.visibilityState,resources:performance.getEntriesByType('resource').filter(x=>x.name.includes('/data')).map(x=>({initiatorType:x.initiatorType,name:x.name,startTime:x.startTime,responseEnd:x.responseEnd,transferSize:x.transferSize}))}},${delay});</script></body></html>`);
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify(server.address())));
