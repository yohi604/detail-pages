/* GitHub Pages publisher. Tokens live only in this module's WeakMap. */
const sessions = new WeakMap();
const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROJECT_BYTES = 400 * 1024 * 1024;
const MAX_ITEMS = 300;
const FORMAT = 'detail-flow';
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value);
const pathEncode = path => path.split('/').map(encodeURIComponent).join('/');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const num = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

export class GitHubError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'GitHubError'; this.status = status; this.code = code; }
}

function session(connection) {
  const state = sessions.get(connection);
  if (!state) throw new GitHubError('GitHub 연결이 만료되었습니다. 다시 연결해 주세요.', 0, 'DISCONNECTED');
  return state;
}

async function api(state, endpoint, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch(`${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}${endpoint}`, {
      method: options.method || 'GET',
      headers: {'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${state.token}`, 'X-GitHub-Api-Version': API_VERSION, ...(options.body ? {'Content-Type':'application/json'} : {})},
      ...(options.body ? {body: JSON.stringify(options.body)} : {}),
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
  } catch (error) {
    throw new GitHubError(error.name === 'AbortError' ? 'GitHub 응답 시간이 초과되었습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.' : 'GitHub에 연결할 수 없습니다. 네트워크를 확인해 주세요.', 0, 'NETWORK');
  } finally { clearTimeout(timeout); }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (options.allow404 && response.status === 404) return null;
    let message = 'GitHub 요청을 처리하지 못했습니다.';
    if (response.status === 401) message = '토큰이 유효하지 않거나 만료되었습니다. 새 토큰으로 연결해 주세요.';
    else if (response.status === 403 || response.status === 429) message = response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(data.message || '') ? 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' : 'GitHub 권한이 부족합니다. 선택한 저장소의 Contents 쓰기 권한과 Pages 읽기 권한을 확인해 주세요.';
    else if (response.status === 404) message = '저장소나 파일을 찾을 수 없습니다. 저장소 이름과 토큰의 접근 범위를 확인해 주세요.';
    else if (response.status === 409 || response.status === 422) message = '다른 변경과 충돌했거나 저장소 규칙에서 게시를 차단했습니다. 작업을 보관한 뒤 GitHub 설정을 확인하고 다시 시도해 주세요.';
    throw new GitHubError(message, response.status, 'API');
  }
  return data;
}

function normalizePages(pages) {
  if (!pages) throw new GitHubError('먼저 GitHub 저장소의 Settings → Pages에서 Deploy from a branch를 선택하고 브랜치와 /(root) 또는 /docs를 저장해 주세요.', 404, 'PAGES_SETUP');
  if (pages.build_type === 'workflow' || !pages.source?.branch || !['/', '/docs'].includes(pages.source.path)) throw new GitHubError('이 연결은 GitHub Pages의 Deploy from a branch 방식을 지원합니다. 전용 저장소에서 브랜치 방식으로 설정해 주세요.', 0, 'PAGES_SOURCE');
  if (!pages.html_url || !/^https?:\/\//.test(pages.html_url)) throw new GitHubError('GitHub Pages 주소가 아직 준비되지 않았습니다. Pages 설정을 확인해 주세요.', 0, 'PAGES_URL');
  return {branch: pages.source.branch, rootPath: pages.source.path === '/docs' ? 'docs/' : '', baseUrl: pages.html_url.replace(/\/$/, '') + '/'};
}

/** Read-only connection check. Does not create a repository or change its settings. */
export async function connectGitHub({owner, repo, token}) {
  owner = String(owner || '').trim(); repo = String(repo || '').trim().replace(/\.git$/, ''); token = String(token || '').trim();
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || !token) throw new GitHubError('GitHub 사용자명, 저장소 이름, 토큰을 모두 입력해 주세요.', 0, 'INPUT');
  const state = {owner, repo, token};
  const metadata = await api(state, '');
  if (metadata.private || metadata.visibility === 'private' || metadata.visibility === 'internal') throw new GitHubError('공유 링크용 Public 저장소를 선택해 주세요.', 0, 'PRIVATE_REPO');
  if (metadata.archived || metadata.disabled) throw new GitHubError('보관되었거나 비활성화된 저장소에는 게시할 수 없습니다.', 0, 'REPO_READONLY');
  if (metadata.permissions && metadata.permissions.push === false) throw new GitHubError('이 저장소에 쓰기 권한이 없습니다.', 0, 'NO_WRITE_ACCESS');
  const pages = await api(state, '/pages', {allow404:true});
  const config = normalizePages(pages);
  await api(state, `/git/ref/heads/${pathEncode(config.branch)}`);
  const connection = Object.freeze({owner:metadata.owner.login, repo:metadata.name, repositoryUrl:metadata.html_url, ...config});
  sessions.set(connection, {...state, ...config, owner:metadata.owner.login, repo:metadata.name, publishing:false});
  return connection;
}

export function disconnectGitHub(connection) { sessions.delete(connection); }

function projectPath(state, id) {
  if (!safeId(id)) throw new GitHubError('프로젝트 식별자가 올바르지 않습니다.', 0, 'PROJECT_ID');
  return `${state.rootPath}details/${id}`;
}

async function contents(state, path, ref, allow404 = false) {
  return api(state, `/contents/${pathEncode(path)}?ref=${encodeURIComponent(ref)}`, {allow404});
}

function decodeJSON(file) {
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || !file.content) throw new GitHubError('프로젝트 데이터 형식을 읽을 수 없습니다.', 0, 'MANIFEST');
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')), x => x.charCodeAt(0)))); }
  catch { throw new GitHubError('프로젝트 데이터가 손상되었습니다.', 0, 'MANIFEST'); }
}

function validateManifest(data, expectedId) {
  if (data?.format !== FORMAT || data.version !== 1 || data.id !== expectedId || !Array.isArray(data.items) || data.items.length > MAX_ITEMS) throw new GitHubError('이 폴더는 Detail Flow 프로젝트가 아니거나 지원하지 않는 형식입니다.', 0, 'MANIFEST');
  const ids = new Set();
  for (const item of data.items) {
    if (!safeId(item.id) || ids.has(item.id) || !/^assets\/[a-zA-Z0-9_-]+\.(png|jpg|gif|webp)$/.test(item.path || '')) throw new GitHubError('프로젝트 이미지 경로가 올바르지 않습니다.', 0, 'MANIFEST');
    ids.add(item.id);
  }
  return data;
}

/** Public, self-contained viewer markup; image bytes (including GIF animation) stay intact. */
export function buildViewerHTML(manifest) {
  const width = num(manifest.width, 280, 2400, 860);
  const gap = num(manifest.gap, 0, 120, 0);
  const bg = /^#[0-9a-fA-F]{6}$/.test(manifest.bg || '') ? manifest.bg : '#ffffff';
  const title = String(manifest.title || '상세페이지').slice(0, 200);
  const images = manifest.items.filter(x => x.visible !== false).map((item, index) => {
    const imagePath = item.path || item.src || item.url || '';
    // Only generated asset paths or data/blob URLs are used by the publishing flow.
    if (!/^assets\/[a-zA-Z0-9_-]+\.(png|jpg|gif|webp)$/.test(imagePath)) throw new GitHubError('공유 페이지 이미지 경로가 올바르지 않습니다.',0,'VIEWER_PATH');
    return `<img src="${esc(imagePath)}" alt="${esc(item.name || `상세 이미지 ${index + 1}`)}" width="${num(item.width, 1, 100000, width)}" height="${num(item.height, 1, 1000000, width)}" ${index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  }).join('\n');
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><meta name="description" content="${esc(title)} 전체 상세페이지"><style>*{box-sizing:border-box}html{background:${bg};scroll-behavior:smooth}body{margin:0;background:${bg}}main{display:flex;flex-direction:column;gap:${gap}px;width:100%;max-width:${width}px;margin:0 auto}img{display:block;width:100%;height:auto;margin:0;border:0}h1{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}</style></head><body><h1>${esc(title)}</h1><main>${images}</main></body></html>`;
}

async function sourceBlob(item) {
  if (item.blob instanceof Blob) return item.blob;
  if (item.file instanceof Blob) return item.file;
  const src = item.src || item.url;
  if (typeof src !== 'string' || !src) throw new GitHubError(`${item.name || '이미지'} 원본을 찾을 수 없습니다. 파일을 다시 올려 주세요.`,0,'IMAGE_SOURCE');
  let url;
  try { url = new URL(src, globalThis.location?.href || 'http://localhost/'); } catch { throw new GitHubError('이미지 주소가 올바르지 않습니다.',0,'IMAGE_SOURCE'); }
  if (!['http:','https:','blob:','data:'].includes(url.protocol)) throw new GitHubError('지원하지 않는 이미지 주소입니다.',0,'IMAGE_SOURCE');
  const result = await fetch(url.href, {credentials:url.origin === globalThis.location?.origin ? 'same-origin' : 'omit', cache:'no-cache'});
  if (!result.ok) throw new GitHubError(`${item.name || '이미지'} 원본을 불러오지 못했습니다.`,result.status,'IMAGE_SOURCE');
  return result.blob();
}

async function imageType(blob, name) {
  const bytes = new Uint8Array(await blob.slice(0,16).arrayBuffer());
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return {mime:'image/png', ext:'png'};
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return {mime:'image/jpeg', ext:'jpg'};
  const ascii = new TextDecoder('ascii').decode(bytes);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return {mime:'image/gif', ext:'gif'};
  if (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP') return {mime:'image/webp', ext:'webp'};
  throw new GitHubError(`${name || '파일'}: PNG, JPG, GIF, WebP 이미지만 게시할 수 있습니다.`,0,'IMAGE_TYPE');
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

function progress(callback, phase, completed, total, label) {
  if (typeof callback === 'function') callback({phase,completed,total,label,percent:Math.round(completed / Math.max(total,1) * 100)});
}

/** Atomic project update: blobs → tree → commit → one non-force branch update. */
export async function publishProject(connection, project, onProgress) {
  const state = session(connection);
  if (state.publishing) throw new GitHubError('게시가 이미 진행 중입니다.',0,'BUSY');
  // Keep the publication consistent if the editor changes while uploads run.
  project = {...project,items:Array.isArray(project.items) ? project.items.map(item => ({...item})) : project.items};
  state.publishing = true;
  try {
    const folder = projectPath(state, project.id);
    if (!Array.isArray(project.items) || !project.items.length || project.items.length > MAX_ITEMS) throw new GitHubError(`이미지를 1~${MAX_ITEMS}개로 구성해 주세요.`,0,'ITEM_COUNT');
    if (!project.items.some(x => x.visible !== false)) throw new GitHubError('공유할 이미지가 모두 숨겨져 있습니다.',0,'NO_VISIBLE_ITEMS');
    const ids = new Set();
    for (const item of project.items) {
      if (!safeId(item.id) || ids.has(item.id)) throw new GitHubError('이미지 식별자가 중복되었거나 올바르지 않습니다.',0,'ITEM_ID');
      ids.add(item.id);
    }
    progress(onProgress,'checking',0,project.items.length + 3,'GitHub 게시 준비');
    const repo = await api(state,'');
    if (repo.private || repo.visibility === 'internal' || repo.archived || repo.disabled) throw new GitHubError('저장소가 공개 또는 쓰기 가능한 상태가 아닙니다. 다시 연결해 주세요.',0,'REPO_CHANGED');
    const currentPages = normalizePages(await api(state,'/pages'));
    if (currentPages.branch !== state.branch || currentPages.rootPath !== state.rootPath || currentPages.baseUrl !== state.baseUrl) throw new GitHubError('GitHub Pages 설정이 바뀌었습니다. 다시 연결한 뒤 게시해 주세요.',0,'PAGES_CHANGED');
    const head = await api(state,`/git/ref/heads/${pathEncode(state.branch)}`);
    const parent = await api(state,`/git/commits/${head.object.sha}`);
    const existingDirectory = await contents(state,folder,head.object.sha,true);
    if (existingDirectory) {
      if (!Array.isArray(existingDirectory) || !existingDirectory.some(x => x.name === 'manifest.json')) throw new GitHubError('같은 경로에 다른 파일이 있습니다. 새 프로젝트로 복제한 뒤 게시해 주세요.',0,'PATH_COLLISION');
      validateManifest(decodeJSON(await contents(state,`${folder}/manifest.json`,head.object.sha)),project.id);
    }
    const manifest = {format:FORMAT,version:1,id:project.id,title:String(project.title || '상세페이지').slice(0,200),width:num(project.width,280,2400,860),gap:num(project.gap,0,120,0),bg:/^#[0-9a-fA-F]{6}$/.test(project.bg || '') ? project.bg : '#ffffff',updatedAt:new Date().toISOString(),items:[]};
    const tree = [];
    let totalBytes = 0;
    for (let index = 0; index < project.items.length; index++) {
      const item = project.items[index];
      const blob = await sourceBlob(item);
      if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new GitHubError(`${item.name || '이미지'}: 파일당 50MB 이하의 이미지를 사용해 주세요.`,0,'IMAGE_SIZE');
      totalBytes += blob.size;
      if (totalBytes > MAX_PROJECT_BYTES) throw new GitHubError('한 프로젝트는 총 400MB 이하로 구성해 주세요.',0,'PROJECT_SIZE');
      const {mime,ext} = await imageType(blob,item.name);
      const path = `assets/${item.id}.${ext}`;
      progress(onProgress,'uploading',index,project.items.length + 3,`${index + 1}/${project.items.length} · ${item.name || '이미지'} 업로드`);
      const created = await api(state,'/git/blobs',{method:'POST',body:{content:await toBase64(blob),encoding:'base64'}});
      tree.push({path:`${folder}/${path}`,mode:'100644',type:'blob',sha:created.sha});
      manifest.items.push({id:item.id,name:String(item.name || `${item.id}.${ext}`).slice(0,300),width:num(item.width,1,100000,860),height:num(item.height,1,1000000,860),type:mime,bytes:blob.size,path,visible:item.visible !== false});
    }
    // Default layouts/front matter are intentionally absent from viewer HTML.
    tree.push({path:`${folder}/manifest.json`,mode:'100644',type:'blob',content:JSON.stringify(manifest,null,2)});
    tree.push({path:`${folder}/index.html`,mode:'100644',type:'blob',content:buildViewerHTML(manifest)});
    progress(onProgress,'committing',project.items.length,project.items.length + 3,'페이지와 이미지 순서 저장');
    const newTree = await api(state,'/git/trees',{method:'POST',body:{base_tree:parent.tree.sha,tree}});
    const commit = await api(state,'/git/commits',{method:'POST',body:{message:`Detail Flow: ${manifest.title}`,tree:newTree.sha,parents:[head.object.sha]}});
    // Never force-update: a concurrent commit causes a visible retryable conflict.
    await api(state,`/git/refs/heads/${pathEncode(state.branch)}`,{method:'PATCH',body:{sha:commit.sha,force:false}});
    progress(onProgress,'saved',project.items.length + 3,project.items.length + 3,'GitHub 저장 완료 · Pages 반영 대기');
    return {url:new URL(`details/${encodeURIComponent(project.id)}/`,state.baseUrl).href,commitSha:commit.sha,manifest,status:'pending',repositoryUrl:`https://github.com/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`};
  } finally { state.publishing = false; }
}

export async function getPagesStatus(connection) {
  const state = session(connection);
  const pages = await api(state,'/pages');
  const build = await api(state,'/pages/builds/latest',{allow404:true});
  return {status:build?.status || pages.status || 'unknown',commitSha:build?.commit || null,url:pages.html_url,error:build?.error?.message || null,updatedAt:build?.updated_at || null};
}

/** Enumerate only Detail Flow projects; never treats unrelated folders as ours. */
export async function listRemoteProjects(connection) {
  const state = session(connection);
  const listing = await contents(state,`${state.rootPath}details`,state.branch,true);
  if (!listing) return [];
  if (!Array.isArray(listing)) throw new GitHubError('details 경로가 폴더가 아닙니다.',0,'PATH_COLLISION');
  const projects = [];
  for (const entry of listing.filter(x => x.type === 'dir' && safeId(x.name))) {
    const file = await contents(state,`${entry.path}/manifest.json`,state.branch,true);
    if (!file) continue;
    let manifest;
    try { manifest = validateManifest(decodeJSON(file),entry.name); } catch { continue; }
    projects.push({id:manifest.id,title:manifest.title,updatedAt:manifest.updatedAt,count:manifest.items.length,url:new URL(`details/${encodeURIComponent(manifest.id)}/`,state.baseUrl).href});
  }
  return projects.sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function loadRemoteProject(connection, id) {
  const state = session(connection);
  const folder = projectPath(state,id);
  const head = await api(state,`/git/ref/heads/${pathEncode(state.branch)}`);
  const manifest = validateManifest(decodeJSON(await contents(state,`${folder}/manifest.json`,head.object.sha)),id);
  const project = {...manifest,items:[]};
  for (const item of manifest.items) {
    // Fetch the exact branch snapshot, including large GIFs, using the public raw URL.
    // Authorization is never attached to an image host or redirect.
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/${head.object.sha}/${pathEncode(folder)}/${pathEncode(item.path)}`;
    project.items.push({...item,src:rawUrl});
  }
  project.shareUrl = new URL(`details/${encodeURIComponent(id)}/`,state.baseUrl).href;
  return project;
}
