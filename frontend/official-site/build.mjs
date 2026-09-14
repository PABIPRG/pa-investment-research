import {mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const production=process.env.VERCEL_ENV==='production';
let origin='';
if(process.env.SITE_URL){const u=new URL(process.env.SITE_URL);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('SITE_URL 必须是 HTTPS 根域名，例如 https://example.com');origin=u.origin;}
if(production&&!origin)throw Error('生产部署需要 SITE_URL，以生成 canonical 与 sitemap。');
const out=path.join(root,'dist');await mkdir(out,{recursive:true});await rm(path.join(out,'sitemap.xml'),{force:true});
let appUrl='';
if(process.env.WEB_APP_URL){const u=new URL(process.env.WEB_APP_URL);if(u.protocol!=='https:'||u.username||u.password)throw Error('WEB_APP_URL 必须是无用户名密码的 HTTPS 地址');appUrl=u.href;}
let html=await readFile(path.join(root,'index.html'),'utf8');
html=html.replace(/(<span id="copyright-year">)\d{4}/,'$1'+new Date().getFullYear());
const esc=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
let metadata=production?'<meta name="robots" content="index,follow,max-image-preview:large">':'<meta name="robots" content="noindex,follow">';
if(origin)metadata+=`<link rel="canonical" href="${esc(origin)}/"><meta property="og:url" content="${esc(origin)}/"><meta property="og:image" content="${esc(origin)}/app-icon.png"><meta property="og:image:alt" content="投研智能体标志">`;
if(appUrl){
 html=html.replaceAll('data-web-app-url="" aria-disabled="true"',`data-web-app-url="${esc(appUrl)}"`);
 html=html.replaceAll('<span class="entry-label">敬请期待</span>','<span class="entry-label">进入网页版</span>');
}
html=html.replace('</head>',metadata+'</head>');
await writeFile(path.join(out,'index.html'),html);
for(const file of ['style.css','motion.js','app-icon.png'])await copyFile(path.join(root,file),path.join(out,file));
await writeFile(path.join(out,'robots.txt'),'User-agent: *\nAllow: /\n'+(production&&origin?`Sitemap: ${origin}/sitemap.xml\n`:''));
if(production&&origin)await writeFile(path.join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(origin)}/</loc></url></urlset>`);
console.log(`生成 dist：${production?'生产，可索引':'预览，noindex'}。`);
