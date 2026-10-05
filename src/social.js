import { createClient } from '@supabase/supabase-js';
export const db = createClient('https://houaxqkekipxdvqeppkh.supabase.co', 'sb_publishable_tf9Z2v4pF51pxYmYhMvH3g_DXcTFetc', { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const QUEUE='sulkkap:pending-receipts:v1', TICKET='sulkkap:claim-ticket:v1';
export async function call(name,args={}) {
 const {data,error}=await db.rpc(name,args).abortSignal(AbortSignal.timeout(15000));
 if(error) {
  const message = error.code === 'PGRST202' || error.code === '42P01'
    ? '공유·보관 기능이 아직 서버에 준비되지 않았어요. 사이트 운영자가 연결을 완료한 뒤 다시 시도해주세요.'
    : /abort|timeout|fetch/i.test(error.message || '') ? '연결이 지연되고 있어요. 인터넷 연결을 확인한 뒤 다시 시도해주세요.'
    : error.message || '서버에 연결하지 못했어요.';
  throw Object.assign(new Error(message), { code:error.code, detail:error.message });
 }
 return data;
}
let guestTask;
export async function session() { const {data,error}=await db.auth.getSession(); if(error)throw error;return data.session; }
export async function ensureGuest() { let s=await session();if(s)return s;if(!guestTask)guestTask=db.auth.signInAnonymously().then(({data,error})=>{if(error)throw Object.assign(new Error(error.code==='anonymous_provider_disabled' || /anonymous.*disabled/i.test(error.message) ? '비로그인 공유가 아직 준비되지 않았어요. 로그인 후 다시 시도해주세요.' : '공유에 연결하지 못했어요. 잠시 후 다시 시도해주세요.'), {code:error.code,detail:error.message});return data.session;}).finally(()=>guestTask=null);return guestTask; }
export function pending(){try{return JSON.parse(localStorage.getItem(QUEUE)||'[]')}catch{return []}}
export function queueReceipt(record){let list=pending().filter(x=>x.id!==record.id);localStorage.setItem(QUEUE,JSON.stringify([...list,record].slice(-100)));}
let syncTask;
export async function syncReceipts(){if(syncTask)return syncTask;syncTask=(async()=>{await ensureGuest();for(const r of pending()){await call('sk_save_receipt',{p_record:r});localStorage.setItem(QUEUE,JSON.stringify(pending().filter(x=>x.id!==r.id)));}})().finally(()=>syncTask=null);return syncTask;}
export async function prepareLogin(){const s=await session();if(s?.user.is_anonymous){if(pending().length)await syncReceipts();const ticket=await call('sk_prepare_claim');localStorage.setItem(TICKET,ticket);}}
export async function finishLogin(){const s=await session();if(!s||s.user.is_anonymous)return;const ticket=localStorage.getItem(TICKET);if(ticket){await call('sk_claim',{p_token:ticket});localStorage.removeItem(TICKET);}await syncReceipts();}
export async function restore(){let s=await session();if(!s){try{const old=JSON.parse(localStorage.getItem('sulkkap:auth')||'null');if(old?.refresh_token){const r=await db.auth.setSession(old);if(!r.error){s=r.data.session;localStorage.removeItem('sulkkap:auth');}}}catch{}}return s?.user.is_anonymous?null:s;}
export async function passwordAuth(email,password,signup){await prepareLogin();const {data,error}=await (signup?db.auth.signUp({email,password}):db.auth.signInWithPassword({email,password}));if(error)throw error;if(!data.session)throw new Error('가입 확인 메일을 확인해주세요. 현재 서버는 이메일 확인을 요구하고 있어요.');return data.session;}
export async function googleLogin(){await prepareLogin();const {error}=await db.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+window.location.pathname+window.location.search}});if(error)throw error;}
export async function logout(){await finishLogin();const {error}=await db.auth.signOut();if(error)throw error;localStorage.removeItem('sulkkap:auth');localStorage.removeItem(TICKET);}
export function shareUrl(id){const base=import.meta.env.VITE_PUBLIC_SITE_URL?.trim();const u=new URL(base || location.href);if(!/^https?:$/.test(u.protocol))throw new Error('공유 주소 설정을 확인해주세요.');u.search='';u.hash='';u.searchParams.set('share',id);return u.href;}
