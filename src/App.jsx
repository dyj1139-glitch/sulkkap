// 술깝 Groq 연결 + 분석 상태 표시 버전 — src/App.jsx 전체 교체용
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { db, call, ensureGuest, passwordAuth, restore, logout, googleLogin, finishLogin, queueReceipt, syncReceipts, shareUrl } from './social.js';
import { Room, ReceiptQR, socialImage } from './Social.jsx';
import MyPage from './MyPage.jsx';

// 함께 제공한 src 폴더 전체를 교체하세요. JSX 컴포넌트는 .jsx 확장자를 유지합니다.
const LOGO_FONT_CSS = "https://cdn.jsdelivr.net/gh/neodgm/neodgm-webfont@1.601/neodgm/style.css";
const RECEIPT_FONT_CSS = "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400&display=swap";
const RANK_SOURCE = "https://doi.org/10.3390/ijerph18126433";
const RANK_NOTE = "평소 1회 음주량 분포와 비교한 모형 추정";
const NOTICE = "청구 수명과 복원 시간은 재미를 위한 가상 수치이며, 실제 수명 감소·회복을 뜻하지 않습니다.";
// 술깝의 재미용 가상 수명 청구 모델입니다.
// 실제 개인의 수명 감소량을 의미하지 않습니다.
const calculateLifeMinutes = (grams) => {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  let minutes = 0;
  minutes += Math.min(grams, 30) * 1;
  if (grams > 30) minutes += Math.min(grams - 30, 30) * 2;
  if (grams > 60) minutes += Math.min(grams - 60, 40) * 3;
  if (grams > 100) minutes += (grams - 100) * 4;
  return Math.round(minutes);
};
// 비선형 총액을 품목 알코올 비중으로 배분합니다.
// 남은 정수 분은 소수 부분이 큰 품목부터 배분해 합계를 정확히 맞춥니다.
function allocateLifeMinutes(record) {
  const weights = record.items.map(gramsOf);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const shares = weights.map(g => record.minutes * g / sum);
  const amounts = shares.map(Math.floor);
  const order = shares.map((v, index) => ({ index, fraction: v - amounts[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remainder = record.minutes - amounts.reduce((a, b) => a + b, 0);
  for (let n = 0; n < remainder; n++) amounts[order[n % order.length].index]++;
  return amounts;
}
// Lee & Jang (2021), Table 1, KNHANES 2016–2018.
// Published total-column percentages: 1–2 / 3–4 / 5–6 / 7–9 / >=10 drinks.
// Normalize 100.1% (rounding in publication) to 100%. One standard drink = 10g.
// Continuous bin boundaries at half-drinks: 0, 25, 45, 65, 95 grams.
// Within-bin uniform interpolation and the exponential open tail are OUR model,
// not individual ranks published by the authors. No claim of 1%-point accuracy.
const RANK_WEIGHTS = [32.5, 20.6, 15.5, 16.6, 14.9];
const RANK_SUM = RANK_WEIGHTS.reduce((a, b) => a + b, 0);
const RANK_KNOTS = [0, 25, 45, 65, 95].map((g, index) => ({
  grams: g, upper: RANK_WEIGHTS.slice(index).reduce((a, b) => a + b, 0) / RANK_SUM * 100,
}));
const TAIL_START = 95;
const TAIL_RATE = Math.log(RANK_KNOTS[3].upper / RANK_KNOTS[4].upper) / 30;
const RANK_FLOOR_GRAMS = TAIL_START + Math.log(RANK_KNOTS[4].upper / 0.1) / TAIL_RATE;
function estimatePercentile(grams) {
  if (!Number.isFinite(grams) || grams <= 0) return null;
  let upper;
  if (grams >= TAIL_START) {
    upper = RANK_KNOTS[4].upper * Math.exp(-TAIL_RATE * (grams - TAIL_START));
  } else {
    const right = RANK_KNOTS.findIndex((k) => k.grams > grams);
    const a = RANK_KNOTS[right - 1], b = RANK_KNOTS[right];
    upper = a.upper + (b.upper - a.upper) * (grams - a.grams) / (b.grams - a.grams);
  }
  return upper <= 0.1 ? 0.1 : Math.max(1, Math.min(100, Math.round(upper)));
}
const rankLabel = (record) => record.rank === null ? "비교 제외" : `상위 ${record.rank}%`;
const rankCaption = (record) => record.rank === null ? "마신 순수알코올 0g" : record.personal >= TAIL_START ? "통계 상단 구간 · 외삽 모형 추정" : "통계 구간 보간 · 모형 추정";
const DRINKS = [
  { id: "soju", name: "소주", volume: 360, abv: 16, units: ["병"] },
  { id: "red", name: "소주(빨간뚜껑)", volume: 360, abv: 20, units: ["병"] },
  { id: "beer", name: "맥주", volume: 355, abv: 5, units: ["캔", "병", "잔"] },
  { id: "highball", name: "하이볼", volume: 30, abv: 40, units: ["잔"] },
  { id: "mak", name: "막걸리", volume: 750, abv: 6, units: ["병"] },
  { id: "wine", name: "와인", volume: 750, abv: 12, units: ["병", "잔"] },
  { id: "spirit", name: "양주", volume: 700, abv: 40, units: ["병", "잔"] },
  { id: "sake", name: "사케", volume: 720, abv: 15, units: ["병", "잔"] },
  { id: "other", name: "기타", volume: 100, abv: 10, units: ["개", "병", "잔"] },
];
// 용기마다 실제 제품 용량은 다릅니다. 아래 값은 수정 가능한 입력 예시입니다.
const volumeOptions = (type, unit) => {
  if (type === "beer") return unit === "캔" ? [355, 500] : unit === "병" ? [330, 500, 640] : [300, 500];
  if (type === "highball") return [30, 45, 60];
  if (unit === "잔") return type === "wine" ? [125, 150] : type === "spirit" ? [30, 45] : [50, 100];
  return { soju: [360], red: [360], mak: [750, 1000], wine: [750], spirit: [500, 700, 750], sake: [300, 720, 1800], other: [100, 500] }[type] || [];
};
const defaultVolume = (type, unit) => type === "beer" ? (unit === "캔" ? 355 : 500) : unit === "잔" ? ({ wine: 150, spirit: 30, sake: 50 }[type] || definition(type).volume) : definition(type).volume;
const DRAFT_KEY = "sulkkap:draft:v2"; // 기존 키를 유지하면서 이전 초안을 v4 흐름으로 이동합니다.
const EXAMPLE_TEXT = "하이볼도 마시고 양주도 3잔 마셨고 소주 3병, 빨깐뚜껑 소주는 9병이야. 맥주는 커다란 페트병에 절반 정도 마셨어.";
const unitLabel = (item) => item.container === "pet" ? "페트병" : item.unit;
const defaultsOf = (item) => Array.isArray(item.defaultFields) ? item.defaultFields : item.edited ? [] : ["volume", "abv"];
const patchEntry = (item, field, value) => ({ ...item, [field]: value,
  defaultFields: defaultsOf(item).filter(v => v !== field), edited: item.edited || ["volume", "abv"].includes(field) });
function readDraft() {
  const empty = { occasion: "", people: 1, items: [], narrative: "", page: 0 };
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (!d || ![2, 3, 4].includes(d.version) || !Array.isArray(d.items) || d.items.length > 60) return empty;
    const items = d.items.filter(i => i && definition(i.type) && typeof i.id === "string" && typeof i.name === "string" && typeof i.spirit === "string" && definition(i.type).units.includes(i.unit) && ["quantity", "volume", "abv", "left"].every(k => typeof i[k] === "number" || typeof i[k] === "string") && (d.version !== 2 || (Array.isArray(d.selected) && d.selected.includes(i.type))))
      .map(i => ({ ...i, container: i.type === "beer" && i.unit === "병" && i.container === "pet" ? "pet" : "", defaultFields: defaultsOf(i).filter(v => ["volume", "abv"].includes(v)) }));
    const oldPage = [6, 1].includes(d.page) ? 1 : [2, 3, 4].includes(d.page) ? 2 : 0;
    return { occasion: typeof d.occasion === "string" ? d.occasion.slice(0, 40) : "", people: Number.isInteger(d.people) && d.people >= 1 && d.people <= 10000 ? d.people : 1,
      items, narrative: typeof d.narrative === "string" ? d.narrative.slice(0, 1200) : "", page: d.version === 2 ? (oldPage === 2 ? 3 : oldPage) : d.version === 3 ? (d.page === 2 || d.page === 4 ? 3 : [0, 1].includes(d.page) ? d.page : 0) : [0, 1, 2, 3].includes(d.page) ? d.page : 3 };
  } catch { return empty; }
}
// 고정된 예시입니다. 입력 문장을 분석하거나 외부 API를 호출하지 않습니다.
function makeExampleItems() {
  return [
    { ...createItem("highball"), quantity: "", defaultFields: ["volume", "abv"], source: "example" },
    { ...createItem("spirit"), quantity: 3, unit: "잔", volume: 30, defaultFields: ["volume", "abv"], source: "example" },
    { ...createItem("soju"), quantity: 3, source: "example" },
    { ...createItem("red"), quantity: 9, source: "example" },
    { ...createItem("beer"), quantity: 0.5, unit: "병", container: "pet", volume: 1600, defaultFields: ["volume", "abv"], source: "example" },
  ];
}
function missingPrompt(item) {
  if (item.quantity === "") return `몇 ${item.unit === "잔" ? "잔" : item.unit} 마셨나요?`;
  if (item.volume === "") return item.container === "pet" ? "페트병 전체 용량을 골라주세요." : item.type === "highball" ? "한 잔에 넣은 원액은 몇 ml인가요?" : `${item.unit}당 용량을 확인해주세요.`;
  if (item.abv === "") return item.type === "highball" ? "원액 도수를 확인해주세요." : "도수를 확인해주세요.";
  if (item.type === "highball" && !item.spirit.trim()) return "하이볼 원액 종류를 알려주세요.";
  return itemError(item);
}
const MISSIONS = [
  {
    "id": "travel",
    "name": "친구와 여행 다녀오기",
    "caption": "낯선 곳에서 함께 보낼 하루를 만들어봐요.",
    "minutes": 600,
    "group": "big"
  },
  {
    "id": "concert",
    "name": "같이 콘서트 보러 가기",
    "caption": "좋아하는 음악을 같은 자리에서 듣기.",
    "minutes": 600,
    "group": "big"
  },
  {
    "id": "camping",
    "name": "함께 캠핑 다녀오기",
    "caption": "텐트 밖에서 오래 이야기 나눌 밤.",
    "minutes": 600,
    "group": "big"
  },
  {
    "id": "meal",
    "name": "같이 밥 한 끼 먹기",
    "caption": "거창한 약속 대신, 함께 먹는 밥 한 끼.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "movie",
    "name": "같이 영화 한 편 보기",
    "caption": "보고 나서 가장 좋았던 장면 이야기하기.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "cooking",
    "name": "같이 요리해서 한 끼 먹기",
    "caption": "장보기부터 설거지까지 함께해봐요.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "picnic",
    "name": "공원에서 피크닉하기",
    "caption": "돗자리와 간식만 있어도 충분해요.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "exercise",
    "name": "같이 운동하러 가기",
    "caption": "배드민턴, 볼링, 가벼운 러닝 중 하나.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "exhibition",
    "name": "전시나 박물관 같이 가기",
    "caption": "서로 눈길이 머문 작품을 알려주세요.",
    "minutes": 60,
    "group": "near"
  },
  {
    "id": "walk",
    "name": "함께 가볍게 산책하기",
    "caption": "걸으면서 못다 한 이야기 나누기.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "tea",
    "name": "술 대신 차 한 잔 마시기",
    "caption": "이번에는 잔보다 이야기를 채워봐요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "call",
    "name": "안부 묻고 잠깐 통화하기",
    "caption": "잘 지내냐는 말로 시작해도 충분해요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "game",
    "name": "함께 게임 한 판 하기",
    "caption": "이기는 것보다 같이 웃는 한 판.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "thanks",
    "name": "서로에게 고마웠던 일 말하기",
    "caption": "짧은 한마디도 괜찮아요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "photo",
    "name": "그날 사진 보며 추억 나누기",
    "caption": "사진 한 장에 남은 이야기를 꺼내봐요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "music",
    "name": "서로에게 노래 한 곡 추천하기",
    "caption": "요즘 자주 듣는 노래와 그 이유를 전해요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "plan",
    "name": "술 없는 다음 만남 정하기",
    "caption": "영화, 전시, 맛집 중 하나를 같이 골라봐요.",
    "minutes": 30,
    "group": "today"
  },
  {
    "id": "laugh",
    "name": "재밌는 영상 하나 나누기",
    "caption": "친구 생각이 난 장면을 함께 보고 웃어요.",
    "minutes": 30,
    "group": "today"
  }
];
const MISSION_GROUPS = [
  { id: "big", title: "언젠가 같이, 크게 한 번", subtitle: "기억에 남을 약속 · 미션마다 10시간" },
  { id: "near", title: "가까운 날, 같이 해볼까요?", subtitle: "함께 보내는 시간 · 미션마다 1시간" },
  { id: "today", title: "오늘도 할 수 있는 일", subtitle: "작은 약속부터 · 미션마다 30분" },
];
const missionRewardLabel = minutes => minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
function MissionChoices({ available = MISSIONS.map(m => m.id), checked, onToggle, disabled = false }) {
  return MISSION_GROUPS.map(group => {
    const list = MISSIONS.filter(m => m.group === group.id && available.includes(m.id));
    if (!list.length) return null;
    return <section className={`mission-group mission-group-${group.id}`} key={group.id}>
      <h3>{group.title}</h3><p>{group.subtitle}</p>
      {list.map(m => <label className="mission-row" key={m.id}>
        <input type="checkbox" disabled={disabled} checked={checked.includes(m.id)} onChange={() => onToggle(m.id)} />
        <span><strong>{m.name}</strong><small>{m.caption}</small></span>
        <small className="mission-reward">+{missionRewardLabel(m.minutes)}</small>
      </label>)}
    </section>;
  });
}

const SUPABASE_URL = "https://houaxqkekipxdvqeppkh.supabase.co";
// 공개용 키입니다. secret/service_role 키로 바꾸지 마세요.
const SUPABASE_KEY = "sb_publishable_tf9Z2v4pF51pxYmYhMvH3g_DXcTFetc";
const AUTH_KEY = "sulkkap:auth";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAuthSession() { return null; }
async function signInWithPassword(email,password) { return passwordAuth(email,password,false); }
async function signUpWithPassword(email,password) { return passwordAuth(email,password,true); }
async function signOutSession() { return logout(); }
async function restoreAuthSession() { return restore(); }
function EyeIcon({ open }) {
  return open
    ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
    : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1" /><path d="M6.1 6.1A17.5 17.5 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.2-.9" /></svg>;
}
async function rpc(name, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`연결 오류 (${response.status}). Supabase SQL 실행 여부와 프로젝트 주소·공개 키를 확인해주세요.`);
    return await response.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("연결이 지연되고 있어요. 잠시 후 다시 시도해주세요.");
    throw e;
  } finally { clearTimeout(timer); }
}
// 서버에 저장된 임의 JSON도 그대로 신뢰하지 않고 입력을 검증·재계산합니다.
// Calls our Supabase function; no Groq secret is bundled in this frontend.
const ANALYSIS_MESSAGES = {
  RATE_LIMIT: "분석 요청이 몰렸거나 무료 사용량에 도달했어요. 잠시 후 다시 시도하거나 직접 입력해주세요.",
  TIMEOUT: "분석이 오래 걸리고 있어요. 다시 시도하거나 항목으로 직접 입력해주세요.",
  CONFIG: "분석 서버 설정을 확인해야 해요. 지금은 항목으로 직접 입력할 수 있어요.",
  CLARIFY: "함께 마신 전체 양인지 구분하기 어려워요. ‘모두 합쳐 소주 3병’처럼 적어주세요.",
  EMPTY: "술 종류를 찾지 못했어요. 마신 술 이름과 기억나는 수량을 적어주세요.",
  INPUT: "입력 내용을 확인해주세요. 1,200자 이내로 적을 수 있어요.",
};
async function analyzeDrinks({ text, people, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/super-task`, {
      method: "POST", signal: controller.signal,
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, people }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = ANALYSIS_MESSAGES[data?.code] || (response.status === 401 || response.status === 404
        ? "분석 함수 배포·인증 설정을 확인해야 해요. 지금은 직접 입력해주세요."
        : "분석 서버에 연결하지 못했어요. 다시 시도하거나 직접 입력해주세요.");
      throw Object.assign(new Error(message), { userMessage: message });
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("timeout"), { userMessage: ANALYSIS_MESSAGES.TIMEOUT });
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

function normalizeRecord(raw) {
  if (!raw || !Number.isInteger(raw.people) || raw.people < 1 || raw.people > 10000 ||
      !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 60 ||
      typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) throw new Error("영수증 형식이 올바르지 않아요.");
  const items = raw.items.map((i, index) => {
    if (!i || !definition(i.type) || typeof i.name !== "string" || i.name.length > 80 ||
        !definition(i.type).units.includes(i.unit) || typeof i.spirit !== "string" || i.spirit.length > 80) throw new Error("술 항목이 올바르지 않아요.");
    const v = { id: `shared-${index}`, type: i.type, name: i.name, unit: i.unit, spirit: i.spirit,
      quantity: i.quantity, volume: i.volume, abv: i.abv, left: i.left, container: i.type === "beer" && i.unit === "병" && i.container === "pet" ? "pet" : "" };
    if (itemError(v)) throw new Error("술 수량이나 세부사항이 올바르지 않아요.");
    return v;
  });
  const total = items.reduce((sum, i) => sum + gramsOf(i), 0), personal = total / raw.people;
  return { id: typeof raw.id === "string" ? raw.id : uid(), date: raw.date, occasion: typeof raw.occasion === "string" ? raw.occasion.trim().slice(0, 40) || "우리의 술자리" : "우리의 술자리", people: raw.people, items,
    total, personal, minutes: calculateLifeMinutes(personal), rank: estimatePercentile(personal) };
}
export async function createShareLink({record,purpose,missions,message=""}) {
  const clean=normalizeRecord(record); await ensureGuest();
  const id=await call('sk_create_room',{p_record:clean,p_purpose:purpose,p_message:message.trim(),p_missions:missions});
  if(!UUID_RE.test(id)) throw new Error('공유 응답이 올바르지 않아요.');
  return {id,url:shareUrl(id)};
}
async function readShare(id) {
  if(!UUID_RE.test(id))throw new Error('올바르지 않은 공유 링크예요.');
  let data;
  try { data=await call('sk_read_room',{p_id:id}); } catch(e) { if(e.code !== 'PGRST202') throw e; }
  if(data)return {...data,receipt:{...normalizeRecord(data.receipt),id},social:true};
  data=await rpc('get_sulkkap_share',{p_id:id});
  if(!data||!Array.isArray(data.missions)||data.missions.some(id=>!MISSIONS.some(m=>m.id===id)))throw new Error('영수증을 찾지 못했어요.');
  return {...data,id,receipt:{...normalizeRecord(data.receipt),id},social:false};
}
function readChecks(id, missions) {
  try { const value = JSON.parse(localStorage.getItem(`sulkkap:missions:${id}`) || "[]"); return Array.isArray(value) ? [...new Set(value)].filter(v => missions.includes(v)) : []; }
  catch { return []; }
}
function recoveredMinutes(record, checked) {
  return Math.min(record.minutes, MISSIONS.filter(m => checked.includes(m.id)).reduce((n, m) => n + m.minutes, 0));
}
function ShareIcon() {
  return <svg className="share-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M12 15V3m-4 4 4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>;
}
const definition = (id) => DRINKS.find((d) => d.id === id);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const createItem = (type, name = "") => {
  const d = definition(type);
  return { id: uid(), type, name: name || d.name, quantity: 1, volume: d.volume,
    abv: d.abv, unit: d.units[0], left: 0, spirit: "위스키", container: "", defaultFields: ["volume", "abv"], edited: false };
};
const gramsOf = (i) => (Number(i.quantity) - Number(i.left)) * Number(i.volume) * Number(i.abv) / 100 * 0.789;
const formatTime = (minutes) => {
  const n = Math.max(0, Math.round(minutes));
  return n >= 60 ? `${Math.floor(n / 60)}시간 ${String(n % 60).padStart(2, "0")}분` : `${n}분`;
};
const itemError = (i) => {
  if (!i.name.trim()) return "술 이름을 입력해주세요.";
  if (i.quantity === "" || !Number.isFinite(Number(i.quantity)) || Number(i.quantity) <= 0) return "수량은 0보다 크게 입력해주세요.";
  if (i.volume === "" || !Number.isFinite(Number(i.volume)) || Number(i.volume) <= 0) return "용량은 0보다 크게 입력해주세요.";
  if (i.abv === "" || !Number.isFinite(Number(i.abv)) || Number(i.abv) < 0 || Number(i.abv) > 100) return "도수는 0~100%로 입력해주세요.";
  if (!Number.isFinite(Number(i.left)) || Number(i.left) < 0 || Number(i.left) > Number(i.quantity)) return "남긴 수량은 전체 수량 이내로 입력해주세요.";
  if (i.type === "highball" && !i.spirit.trim()) return "하이볼 원액의 종류를 입력해주세요.";
  if (!Number.isFinite(gramsOf(i)) || gramsOf(i) > 1e9) return "입력값이 계산 범위를 초과했어요. 수량과 용량을 확인해주세요.";
  return "";
};

const CSS = `
.sk .mission-counter{position:sticky;top:0;z-index:2;background:#ecedec;padding:10px 0;font-size:13px;color:var(--green);line-height:1.6}.sk .mission-row:has(input:disabled:not(:checked)){opacity:.5}

.sk .occasion-form{flex:1;display:flex;flex-direction:column}.sk .occasion-form input{font-size:20px;min-height:56px}.sk .occasion-context{font-size:14px;border-bottom:1px solid var(--line);padding-bottom:18px;overflow-wrap:anywhere}.sk .occasion-name{font-size:18px!important;margin:20px 0 8px!important;overflow-wrap:anywhere}.sk .volume-picker{margin:16px 0 22px}.sk .volume-label{display:block;font-size:13px;font-weight:600;margin:0 0 8px}.sk .unit-options,.sk .volume-options{display:flex;gap:7px;flex-wrap:wrap}.sk .unit-options button,.sk .volume-options button{min-height:44px;min-width:52px;padding:8px 12px;border:1px solid var(--line);border-radius:4px;background:transparent}.sk .unit-options button[aria-pressed=true],.sk .volume-options button[aria-pressed=true]{border-color:var(--green);background:#e4ebe6;color:var(--green)}.sk .volume-direct{display:flex;align-items:center;gap:8px;margin-top:10px}.sk .volume-direct input{min-height:44px;width:100px;max-width:45%;padding:9px;border:1px solid var(--line);background:#fff;border-radius:4px;font-size:16px}.sk .volume-direct small{color:var(--muted);font-size:12px}.sk .quantity-row input{min-width:0}.sk .quantity-form .hint{font-size:12px;color:var(--muted);line-height:1.6;margin:8px 0}.sk .quantity-form .summary-box .row{gap:12px}.sk .summary-box .row span{overflow-wrap:anywhere}

.sk .mission-row{display:flex;align-items:center;gap:12px;min-height:76px;padding:16px 0;border-bottom:1px solid var(--line);cursor:pointer}.sk .mission-row input{width:22px;height:22px;flex-shrink:0;accent-color:var(--green)}.sk .mission-row span{flex:1;min-width:0}.sk .mission-row strong{display:block;font-size:15px;line-height:1.5;word-break:keep-all}.sk .mission-row small{display:block;font-size:12px;color:var(--muted);line-height:1.6}.sk .mission-row+button{margin-top:24px}.sk .recovery-total{font-size:30px;color:#252724}.sk .link-button{display:inline-block}.sk textarea{max-width:100%}

.sk .share-icon{display:inline-block;vertical-align:middle;margin-right:9px;flex-shrink:0}.sk .result-actions .primary,.sk .sheet> .primary{display:flex;align-items:center;justify-content:center}.sk .connection-intro{font-size:14px;line-height:1.7;color:#59625c;margin:0 0 20px;word-break:keep-all}.sk .connection-caption{font-size:14px;line-height:1.7;color:#45594d;margin:0 0 20px;word-break:keep-all;min-height:48px}.sk .message-label{display:block;font-size:12px;color:#70756f;margin:0 0 9px}.sk .sheet-head h2{letter-spacing:-.7px}

*{box-sizing:border-box}html{background:#ecedec;color-scheme:light}body{margin:0;display:block;min-width:320px;color:#252724;background:#ecedec;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}#root{width:100%;max-width:none;margin:0;padding:0;text-align:left}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed}button,a,input,textarea,select{-webkit-tap-highlight-color:transparent}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #387158;outline-offset:4px}button{color:inherit}button:active:not(:disabled){transform:translateY(1px)}
.sk{--green:#244b3d;--muted:#70756f;--line:#d4d8d2;max-width:440px;min-height:100svh;margin:auto;background:#ecedec;overflow-x:clip}.sk h1,.sk h2,.sk h3,.sk p{margin-top:0}.sk p{line-height:1.7}.sk .care-section{border-top:1px solid var(--line);margin-top:30px;padding-top:26px}.sk .care-section h2{font-size:18px;line-height:1.5;margin-bottom:10px;word-break:keep-all}.sk .care-section p{font-size:14px;color:var(--muted);word-break:keep-all;margin-bottom:20px}.sk .result-copy textarea{width:100%;min-height:140px;margin:12px 0;padding:12px;font:inherit}.sk .mono{font-family:monospace}.sk .paper,.sk .paper *{font-family:'Noto Serif KR','Batang','바탕',serif;font-variant-numeric:tabular-nums;font-weight:400;font-synthesis:none;letter-spacing:0}.sk .sk-logo,.sk .paper .brand{font-family:'NeoDunggeunmo',monospace;font-weight:400}.sk-header{height:76px;padding:0 24px;display:flex;align-items:center;justify-content:space-between}.sk-logo{font-size:28px;color:#1b3125;line-height:1}.sk-back{border:0;background:transparent;padding:10px 0;min-width:44px;min-height:44px;font-size:14px;text-align:left}.sk-header small{color:var(--muted);font-size:12px}.sk-stage{padding:22px 24px 30px;min-height:calc(100svh - 76px);display:flex;flex-direction:column;animation:rise .52s cubic-bezier(.2,.72,.2,1) both}.sk-stage.home{animation:none;padding-top:30px}.sk h1{font-size:30px;line-height:1.4;letter-spacing:-1.5px;margin-bottom:12px;word-break:keep-all}.sk h1 em{font-style:normal;color:var(--green)}.sk .sub{font-size:15px;color:var(--muted);margin-bottom:32px;word-break:keep-all}.sk .eyebrow{font-size:12px;color:var(--green);margin-bottom:14px;letter-spacing:1px}.sk .primary,.sk .secondary{width:100%;min-height:56px;padding:14px 16px;border-radius:7px;font-size:16px;font-weight:700;line-height:1.4}.sk .primary{background:var(--green);color:#fff;border:1px solid var(--green)}.sk .primary:disabled{background:#d5d8d0;color:#73796e;border-color:#d5d8d0}.sk .secondary{border:1px solid #b8bbb0;background:transparent}.sk .actions{margin-top:auto;padding-top:34px;padding-bottom:env(safe-area-inset-bottom)}.sk .actions p{font-size:12px;color:var(--muted);text-align:center;margin:12px 0 0}.sk .footnote{font-size:12px;color:#70756f;line-height:1.65;margin:25px 0 0;word-break:keep-all}.sk .error{color:#96392a;font-size:13px;line-height:1.6;margin:15px 0}.sk .step-dots{display:flex;gap:5px;margin-bottom:26px}.sk .step-dots i{height:3px;width:24px;background:#d5d8ce}.sk .step-dots i.on{background:var(--green)}
.sk .preview-wrap{margin:2px auto 20px;width:240px;position:relative}.sk .example{font-size:12px;color:#70756f;display:block;text-align:center;margin:23px 0 0}.sk .paper{background:#fefefc;color:#252724;position:relative;box-shadow:0 3px 7px #24282418,0 17px 26px #2428240a;background-image:var(--grain)}.sk .paper:after{content:'';position:absolute;left:0;right:0;bottom:-8px;height:9px;background:#fefefc;clip-path:polygon(0 0,100% 0,100% 25%,98% 100%,96% 25%,94% 100%,92% 25%,90% 100%,88% 25%,86% 100%,84% 25%,82% 100%,80% 25%,78% 100%,76% 25%,74% 100%,72% 25%,70% 100%,68% 25%,66% 100%,64% 25%,62% 100%,60% 25%,58% 100%,56% 25%,54% 100%,52% 25%,50% 100%,48% 25%,46% 100%,44% 25%,42% 100%,40% 25%,38% 100%,36% 25%,34% 100%,32% 25%,30% 100%,28% 25%,26% 100%,24% 25%,22% 100%,20% 25%,18% 100%,16% 25%,14% 100%,12% 25%,10% 100%,8% 25%,6% 100%,4% 25%,2% 100%,0 25%)}.sk .mini{padding:23px 20px;transform:rotate(-3deg);font-size:13px}.sk .mini .brand{text-align:center;font-size:24px;margin-bottom:16px}.sk .mini .rank{text-align:center;font-size:29px;color:var(--green);margin-bottom:14px}.sk .rule{border:0;border-top:1px dashed #969b96;margin:16px 0}.sk .row{display:flex;justify-content:space-between;gap:12px;line-height:1.65}.sk .mini .bill{font-size:17px;text-align:right;margin-top:8px}.sk .mini .game{font-size:11px;text-align:center;margin-top:14px;color:#686b61}.sk .counter{display:flex;align-items:center;justify-content:center;gap:26px;padding:42px 0}.sk .counter button{width:52px;height:52px;border:1px solid #c6cabd;background:transparent;border-radius:50%;font-size:26px}.sk .counter button:disabled{opacity:.35}.sk .people-number{font-size:58px;font-weight:650;min-width:94px;text-align:center;letter-spacing:-2px}.sk .people-number span{font-size:18px;font-weight:400;letter-spacing:0;margin-left:5px}.sk .center-note{text-align:center;color:var(--muted);font-size:14px}.sk .drink-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.sk .drink-choice{min-height:52px;border:1px solid #cbd0c4;background:transparent;border-radius:5px;font-size:14px;padding:10px 4px;word-break:keep-all}.sk .drink-choice[aria-pressed=true]{border:2px solid var(--green);padding:9px 3px;background:#e4ebe6;color:#173c2d;font-weight:700}.sk label.field{display:block;font-size:13px;color:#565d51;margin-top:18px}.sk input,.sk select,.sk textarea{width:100%;min-height:46px;border:1px solid #c8ccbf;background:#fefefc;border-radius:5px;padding:11px;color:#20221c;font-size:16px}.sk label.field input,.sk label.field select{margin-top:8px}.sk .drink-item{border-top:1px solid var(--line);padding:23px 0}.sk .item-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:13px}.sk .item-head h3{font-size:18px;margin:0;word-break:keep-all}.sk .link-button{border:0;background:transparent;min-height:44px;padding:7px 0;color:#525f4d;font-size:13px;text-decoration:underline;text-underline-offset:4px}.sk .quantity-row{display:flex;align-items:center;gap:7px}.sk .quantity-row button{flex:0 0 44px;height:46px;border:1px solid #c8ccbf;background:transparent;border-radius:5px;font-size:22px}.sk .quantity-row input{min-width:0;text-align:center;flex:1;width:50px}.sk .quantity-row select{width:66px;padding:8px}.sk .quantity-row>span{min-width:22px}.sk details{margin-top:15px}.sk summary{cursor:pointer;min-height:44px;padding:12px 0;font-size:13px;color:#52604c}.sk .fields{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;padding-bottom:12px}.sk .fields .wide{grid-column:1/-1}.sk .fields .hint{font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.6;grid-column:1/-1}.sk .fields .field{margin-top:12px}.sk .add{font-size:13px;border:1px dashed #b7bead;background:transparent;min-height:44px;width:100%;margin:5px 0 20px;border-radius:4px}.sk .summary-box{border-top:1px solid var(--line);padding-top:23px;margin-top:12px;font-size:14px}.sk .summary-box h2{font-size:15px}.sk .summary-box p{color:var(--muted);font-size:12px;margin:14px 0 0}
.sk-stage.result{animation:none;padding-top:10px}.sk .result-caption{text-align:center;font-size:12px;color:#6b7064;margin-bottom:20px;min-height:20px}.sk .printer{position:relative;width:100%;max-width:332px;margin:0 auto}.sk .slot{position:relative;z-index:2;height:7px;border-radius:4px;background:#3b3e35;box-shadow:0 2px 0 #b4b6aa;margin:0 -7px}.sk .paper-window{overflow:hidden;padding:0 6px;margin:0 -6px;height:var(--paper-height,900px);animation:print-window 1.9s linear both}.sk .receipt{padding:28px 18px 22px;width:100%;font-size:13px;line-height:1.4;transform-origin:top center;animation:feed-paper 1.9s linear both}.sk .receipt-head{text-align:center;margin-bottom:16px}.sk .receipt-head .brand{font-size:32px;line-height:1.2;margin-bottom:10px}.sk .receipt-head p{font-size:12px;margin-bottom:0}.sk .rank-block{text-align:center;padding:17px 0;border-top:1px dashed #969b96;border-bottom:1px dashed #969b96;margin:18px 0}.sk .rank-block p{margin:0;font-size:13px}.sk .rank-block .rank{font-size:40px;line-height:1.3;color:var(--green);margin:6px 0}.sk .rank-block small{font-size:11px;color:#666b5e}.sk .receipt table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}.sk .receipt th{text-align:left;border-bottom:1px dashed #969b96;padding:8px 0;font-weight:400}.sk .receipt th:nth-child(1){width:45%}.sk .receipt th:nth-child(2){width:19%;text-align:center}.sk .receipt th:nth-child(3){width:36%;text-align:right}.sk .receipt td{vertical-align:top;padding:11px 0 5px;overflow-wrap:anywhere}.sk .receipt td:nth-child(2){text-align:center}.sk .receipt td:nth-child(3){text-align:right}.sk .receipt td small{display:block;color:#747669;font-size:10px;margin-top:4px;line-height:1.4}.sk .receipt .total-label{font-size:16px}.sk .receipt .total{font-size:clamp(22px,6.7vw,29px);text-align:right;margin:10px 0 17px;color:#252724;line-height:1.5;overflow-wrap:anywhere}.sk .receipt .alcohol{font-size:12px}.sk .receipt .receipt-note{font-size:10px;color:#6d7165;text-align:center;margin:8px 0 0}.sk .barcode{display:flex;gap:2px;height:30px;justify-content:center;margin:23px auto 8px;overflow:hidden}.sk .barcode i{height:100%;background:#34372d;flex-shrink:0}.sk .serial{text-align:center;font-size:10px;letter-spacing:2px!important}.sk .result-actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:4px}.sk .result-actions button{font-size:15px}.sk .result-actions .secondary{background:transparent;border-color:#b9bfba;font-weight:500}.sk-stage>h1:focus,.sk .result-caption:focus{outline:none}.sk .rank-block small{display:block;line-height:1.6}.sk .criteria a{color:var(--green);text-underline-offset:3px}.sk .quantity-form{display:flex;flex-direction:column;flex:1}.sk .quantity-form .actions{margin-top:auto}.sk-stage.no-sub .step-dots{margin-bottom:26px}.sk-stage h1 + .drink-grid{margin-top:25px}.sk .share-hint{text-align:center;font-size:13px;color:#54644c;margin:15px 0 20px}.sk .recovered{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:17px 0;margin-top:20px;font-size:14px}.sk .recovered strong{color:var(--green)}.sk .criteria{border-top:1px solid var(--line);margin-top:24px}.sk .criteria p{font-size:12px;color:#676e60;margin:4px 0 13px}.sk .edit-actions{display:flex;justify-content:space-between;margin-top:10px}.sk .status{font-size:13px;color:#52644a;line-height:1.6;margin:14px 0}.sk .modal-backdrop{position:fixed;inset:0;background:#20271f70;z-index:100;display:flex;align-items:flex-end;justify-content:center}.sk .sheet{width:100%;max-width:440px;background:#f4f5f4;border-radius:16px 16px 0 0;padding:14px 24px calc(24px + env(safe-area-inset-bottom));max-height:90dvh;overflow:auto;animation:sheet-rise .35s cubic-bezier(.2,.7,.2,1)}.sk .sheet-handle{width:36px;height:4px;background:#c4c9bb;border-radius:5px;margin:0 auto 13px}.sk .sheet-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.sk .sheet-head h2{font-size:21px;margin:0}.sk .sheet-head button{border:0;background:transparent;min-height:44px;min-width:44px;font-size:24px}.sk .share-summary{border-top:1px dashed #a5ab9a;border-bottom:1px dashed #a5ab9a;padding:13px 0;font-size:14px;margin-bottom:18px}.sk .tones{display:flex;gap:8px;margin:18px 0 13px}.sk .tones button{flex:1;min-height:44px;border:1px solid #c0c7b7;border-radius:5px;background:transparent;font-size:13px}.sk .tones button[aria-pressed=true]{background:#e4ebe6;border-color:var(--green);color:var(--green)}.sk textarea{min-height:100px;resize:vertical;line-height:1.7}.sk .sheet .primary{margin-top:16px}.sk .confirm-share{margin-top:18px;border-top:1px solid var(--line);padding-top:16px}.sk .confirm-share p{font-size:13px}.sk .confirm-buttons{display:flex;gap:10px}.sk .success{text-align:center;padding:20px 0}.sk .success .amount{font-size:38px;color:var(--green);margin:25px 0;animation:small-rise .4s ease both}.sk .success p{font-size:14px}.sk .font-warning{font-size:12px;color:#8a4b30;line-height:1.6;margin:20px 0 0}
@keyframes rise{from{transform:translateY(85svh);opacity:.6}to{transform:translateY(0);opacity:1}}@keyframes sheet-rise{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes small-rise{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes print-window{0%{height:0}20%{height:var(--first-feed,96px)}43%{height:var(--first-feed,96px)}100%{height:var(--paper-height,900px)}}@keyframes feed-paper{0%{transform:translateY(-64px)}20%,43%{transform:translateY(0)}100%{transform:translateY(0)}}@media(max-width:359px){.sk-header{padding:0 18px}.sk-stage{padding-left:18px;padding-right:18px}.sk h1{font-size:27px}.sk .drink-choice{font-size:12px}.sk .receipt{padding-left:13px;padding-right:13px}.sk .quantity-row{gap:5px}}@media(prefers-reduced-motion:reduce){.sk *, .sk *:before,.sk *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.sk .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.sk .people-heading{font-size:17px;margin:30px 0 16px;line-height:1.5}.sk .occasion-form>.hint{font-size:12px;color:var(--muted);margin-top:9px}.sk .input-stage .sub{margin-bottom:18px}.sk .input-context{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);margin-bottom:24px;padding-bottom:8px;font-size:13px}.sk .input-context>span{overflow-wrap:anywhere}.sk .input-context .link-button{flex-shrink:0;min-height:44px}
.sk .natural-input>label{display:block;font-size:15px;font-weight:700;margin-bottom:10px}.sk .natural-input textarea{width:100%;min-height:126px;padding:14px;border:1px solid #b8bfb8;border-radius:5px;background:#f9faf8;font-size:16px;line-height:1.7;resize:vertical}.sk .natural-actions{display:flex;align-items:center;gap:12px;margin-top:10px}.sk .natural-actions .secondary{width:auto;flex:1;min-height:48px;font-size:14px;padding:10px}.sk .natural-actions .secondary:disabled{border-color:#c6cbc6;color:#777e77;background:#e4e7e3;cursor:not-allowed}.sk .natural-actions .link-button{font-size:13px;min-height:44px;white-space:nowrap}.sk .demo-note{font-size:12px;line-height:1.7;color:var(--muted);margin:10px 0 24px;word-break:keep-all}.sk .replace-example{padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:12px 0}.sk .replace-example p{font-size:14px;margin-bottom:12px}.sk .replace-example>div{display:flex;gap:10px}.sk .replace-example button{min-height:48px;font-size:14px}
.sk .input-list-form{display:flex;flex-direction:column;flex:1}.sk .input-list-head{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding-top:14px}.sk .input-list-head h2{font-size:17px;margin:0;line-height:1.5}.sk .input-list-head small{font-size:13px;color:var(--muted);font-weight:400;margin-left:4px}.sk .input-list-head .link-button{font-size:14px;min-height:44px;padding:8px 0}.sk .empty-drinks{text-align:center;padding:27px 0}.sk .empty-drinks p{font-size:14px;color:var(--muted);margin-bottom:18px}.sk .empty-drinks .secondary{width:auto;min-width:154px;font-size:14px;min-height:48px}.sk .compact-drink{padding:20px 0;border-bottom:1px solid var(--line)}.sk .compact-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.sk .compact-head h3{font-size:17px;line-height:1.5;margin:0;overflow-wrap:anywhere}.sk .delete-entry{border:0;background:transparent;min-width:44px;min-height:44px;padding:8px 0;font-size:12px;color:var(--muted);flex-shrink:0}.sk .entry-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:44px;border:0;background:transparent;padding:6px 0;text-align:left;font-size:13px;color:#5f685f}.sk .entry-meta span:first-child{overflow-wrap:anywhere;line-height:1.6}.sk .entry-meta span:last-child{font-size:12px;color:var(--green);white-space:nowrap}.sk .entry-default{font-size:11px;line-height:1.65;color:var(--muted);margin:0 0 12px;word-break:keep-all}.sk .compact-quantity{display:grid;grid-template-columns:44px minmax(0,1fr) 28px 44px;gap:8px;align-items:center;margin:9px 0}.sk .compact-quantity button{min-height:46px;border:1px solid #bfc6bf;background:transparent;border-radius:4px;font-size:23px}.sk .compact-quantity label{min-width:0}.sk .compact-quantity input{display:block;width:100%;min-width:0;height:48px;padding:8px;border:1px solid #bfc6bf;border-radius:4px;background:#f9faf8;text-align:center;font-size:23px;font-weight:600;appearance:textfield}.sk .compact-quantity input::-webkit-inner-spin-button{appearance:none}.sk .compact-quantity>span{font-size:14px;text-align:center}.sk .missing-entry{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:44px;border:0;background:#e6eae4;border-radius:3px;color:#3b583e;text-align:left;padding:10px;font-size:12px;line-height:1.6;margin-top:12px}.sk .missing-entry span{flex-shrink:0;font-size:11px}.sk .add-more{min-height:52px;margin-top:14px;border:1px dashed #aeb8ae;background:transparent;border-radius:4px;color:var(--green);font-size:14px}.sk .input-help{font-size:12px;color:var(--muted);line-height:1.65;margin:15px 0 20px;word-break:keep-all}.sk .input-footer{margin-top:auto;padding-top:17px;padding-bottom:env(safe-area-inset-bottom);border-top:1px solid var(--line)}.sk .input-footer>p{font-size:12px;color:var(--muted);margin:0 0 12px;line-height:1.7}.sk .unresolved-link{display:block;border:0;background:transparent;color:var(--green);padding:10px 0;min-height:44px;font-size:13px;text-align:left;margin-bottom:5px}.sk .entry-sheet .unit-options{margin:8px 0 14px}.sk .entry-sheet .field{display:block;margin:16px 0;font-size:13px}.sk .entry-sheet .volume-picker{margin:18px 0}.sk .entry-sheet .hint{font-size:12px;line-height:1.7;color:var(--muted);margin:10px 0}.sk .editor-details{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:18px 0;padding:6px 0}.sk .editor-details summary{min-height:44px;padding:12px 0;font-size:13px;line-height:1.6;cursor:pointer}.sk .entry-sheet input{font-size:16px}.sk .entry-sheet .primary{margin-top:20px}.sk .entry-sheet .volume-direct input{max-width:60%;width:140px}
@media(max-width:350px){.sk .natural-actions{gap:8px}.sk .natural-actions .secondary{font-size:12px}.sk .natural-actions .link-button{font-size:12px}.sk .missing-entry{align-items:flex-start}.sk .compact-quantity{gap:6px}.sk .input-context{font-size:12px}}

.sk .organize-button[aria-busy="true"]{display:flex;align-items:center;justify-content:center;gap:10px;opacity:1;background:var(--green);color:#fff}.sk .analysis-spinner{display:inline-block;width:18px;height:18px;border:2px solid #ffffff66;border-top-color:#fff;border-radius:50%;animation:analysis-spin .8s linear infinite;flex-shrink:0}.sk .analysis-feedback{margin-top:14px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:14px;line-height:1.65;overflow-wrap:anywhere}.sk .analysis-feedback strong{display:block;font-size:15px}.sk .analysis-feedback p{margin:6px 0 12px;color:var(--muted)}.sk .analysis-feedback .secondary{width:100%;min-height:48px}.sk .analysis-failed{border-top:2px solid #88523d}.sk .analysis-failed strong{color:#78432f}@keyframes analysis-spin{to{transform:rotate(360deg)}}
.sk .narrative-stage .natural-input{margin-top:20px}.sk .organize-button{margin-top:16px}.sk .input-alternatives{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}.sk .input-alternatives .link-button{min-height:44px;font-size:13px}.sk .narrative-stage>.footnote{margin-top:auto;padding-top:28px}.sk .original-story{font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);padding:6px 0 12px;margin-bottom:12px}.sk .original-story summary{min-height:44px;padding:12px 0;cursor:pointer}.sk .original-story p{line-height:1.7;overflow-wrap:anywhere}.sk .review-stage h1{font-size:30px}.sk .review-stage .step-dots{margin-bottom:20px}.sk .review-stage .input-context{margin-bottom:12px}.sk .compact-drink{padding:12px 0}.sk .compact-main{display:grid;grid-template-columns:minmax(0,1fr) 164px;gap:10px;align-items:center}.sk .entry-info{min-height:60px;border:0;background:transparent;text-align:left;padding:0;min-width:0}.sk .entry-info strong{display:block;font-size:15px;line-height:1.4;overflow-wrap:anywhere}.sk .entry-info small{display:block;font-size:11px;color:var(--muted);line-height:1.6;margin-top:3px;overflow-wrap:anywhere}.sk .entry-info .entry-edit-label{color:var(--green)}.sk .compact-quantity{grid-template-columns:44px minmax(0,1fr) 16px 44px;gap:4px;margin:0}.sk .compact-quantity button{height:44px;min-height:44px;font-size:21px}.sk .compact-quantity input{height:44px;min-height:44px;padding:4px;font-size:18px}.sk .compact-quantity>span{font-size:12px}.sk .missing-entry{margin-top:8px}.sk .default-volume-button{min-height:44px;font-size:13px;padding:10px 0}.sk .delete-in-editor{display:block;width:100%;min-height:44px;margin-top:14px;border:0;background:transparent;color:#7c5147;font-size:13px}.sk .recovery-invite{margin:28px 0 0}.sk .recovery-invite h2{font-size:19px;margin:0 0 8px}.sk .recovery-invite p{font-size:13px;line-height:1.7;color:var(--muted);margin:0 0 16px;word-break:keep-all}.sk .recovery-main{display:flex;align-items:center;justify-content:center;gap:4px;min-height:58px;font-size:17px;font-weight:700}.sk .recovery-main>span{margin-left:auto}.sk .recovery-main .share-icon{margin-right:5px}.sk .secondary-result-actions{margin-top:12px}.sk .secondary-result-actions .secondary{display:flex;align-items:center;justify-content:center}.sk .save-button{width:100%;min-height:48px}.sk .mission-counter small{display:block;color:var(--muted);font-size:12px;font-weight:400}.sk .mission-row strong{font-size:14px}.sk .mission-row>small{white-space:nowrap}.sk .mission-row span>small{margin-top:5px}
@media(max-width:350px){.sk .compact-main{gap:8px}.sk .entry-info strong{font-size:14px}.sk .review-stage h1{font-size:28px}.sk .recovery-main{font-size:15px}}

.sk .review-stage h1{font-size:26px;margin-bottom:8px}.sk .review-stage .sub{font-size:14px;margin-bottom:16px}.sk .review-stage .step-dots{margin-bottom:16px}.sk .review-stage .input-context{margin-bottom:4px}

.sk .mission-group{margin-top:26px}.sk .mission-group h3{font-size:16px;margin:0 0 7px;letter-spacing:-.4px}.sk .mission-group>p{font-size:12px;color:var(--muted);line-height:1.6;margin:0 0 7px}.sk .mission-group-big .mission-reward{font-size:18px;font-weight:700;color:var(--green)}.sk .mission-reward{font-size:14px;font-weight:600;white-space:nowrap}.sk .mission-group .mission-row{padding:14px 0;gap:10px}.sk .mission-submit{position:sticky;bottom:0;z-index:3;margin-top:20px;box-shadow:0 -10px 0 #ecedec}.sk .mission-group .mission-row strong{word-break:keep-all;overflow-wrap:anywhere}

.sk .sk-auth{border:0;background:transparent;min-width:44px;min-height:44px;padding:8px 0;font-size:13px;color:#525f4d;text-align:right;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.sk-header>:first-child{flex:1}.sk .sk-logo{flex:0 0 auto}.sk .sk-auth-email{color:var(--green);font-size:12px}.sk .auth-sheet .auth-tabs{display:flex;gap:8px;margin:0 0 18px}.sk .auth-sheet .auth-tabs button{flex:1;min-height:44px;border:1px solid #c0c7b7;border-radius:5px;background:transparent;font-size:14px}.sk .auth-sheet .auth-tabs button[aria-pressed=true]{background:#e4ebe6;border-color:var(--green);color:var(--green);font-weight:700}.sk .auth-sheet .password-field{position:relative}.sk .auth-sheet .password-field input{padding-right:48px}.sk .auth-sheet .password-toggle{position:absolute;right:4px;bottom:2px;border:0;background:transparent;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;color:#5f685f;padding:0}.sk .auth-sheet .primary{margin-top:20px}.sk .auth-sheet .auth-switch{margin-top:14px;text-align:center}.sk .auth-account{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin:4px 0 18px}.sk .auth-account p{margin:0;font-size:14px;line-height:1.7;overflow-wrap:anywhere}.sk .auth-account small{display:block;color:var(--muted);font-size:12px;margin-top:6px}.sk .auth-account .secondary{margin-top:16px}

`;

function Barcode() {
  return <div className="barcode" aria-hidden="true">{Array.from({ length: 48 }, (_, i) => <i key={i} style={{ width: [1, 3, 1, 2, 4, 1, 2][i % 7] }} />)}</div>;
}
function MiniReceipt() {
  return <div className="preview-wrap" aria-label="결과 예시: 상위 비율과 청구 수명이 표시된 영수증">
    <div className="paper mini"><div className="brand">술깝</div><div className="rank">상위 ?%</div>
      <hr className="rule" /><div className="row"><span>소주</span><span>2병</span></div><div className="row"><span>맥주</span><span>3캔</span></div>
      <hr className="rule" /><div>총 청구액</div><div className="bill">수명 −???시간</div>
    </div>
    <span className="example">결과 예시</span>
  </div>;
}
function NumberField({ label, value, onChange, min = 0, max, hint }) {
  return <label className="field">{label}<input type="number" inputMode="decimal" min={min} max={max} step="any" required value={value} onChange={(e) => onChange(e.target.value)} />{hint && <span className="hint">{hint}</span>}</label>;
}
function makeGrain() {
  const c = document.createElement("canvas"); c.width = 90; c.height = 90;
  const ctx = c.getContext("2d"); const im = ctx.createImageData(90, 90);
  let seed = 93;
  for (let i = 0; i < im.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    im.data[i] = 70; im.data[i + 1] = 70; im.data[i + 2] = 70; im.data[i + 3] = seed % 10;
  }
  ctx.putImageData(im, 0, 0); return c.toDataURL();
}

// 출력 중 저장해도 영수증 전체를 이미지로 만듭니다. 화면의 버튼은 제외합니다.
async function receiptImage(record) {
  try { await Promise.all([document.fonts.load('24px "Noto Serif KR"', JSON.stringify(record) + NOTICE + RANK_NOTE + "음주량 기준 추정 상위 통계 구간 보간 모형 외삽 평소 회 자료 품목 수량 청구 시간 원액 남김 전체 순수알코올 인당 총 청구액 수명 결제 수단 나의 시간 최대 주량의 순위가 아닙니다 이상은 외삽 는 모형의 표시 하한입니다 출처 시간 분 비교 제외 0123456789%−. SULKKAP THANK YOU Lee Jang"), document.fonts.load('24px "NeoDunggeunmo"', "술깝")]); } catch { /* fallback */ }
  const font = '"Noto Serif KR", "Batang", "바탕", serif';
  const canvas = document.createElement("canvas"); canvas.width = 640;
  let ctx = canvas.getContext("2d"); const commands = []; let y = 52;
  const text = (s, size = 24, align = "left", x, color = "#252724") => {
    commands.push({ s, size, align, x: x ?? (align === "center" ? 320 : align === "right" ? 596 : 44), y, color });
  };
  const line = () => { y += 16; commands.push({ line: true, y }); y += 26; };
  const wrap = (s, maxWidth, size = 23) => {
    ctx.font = `${size}px ${font}`; const rows = []; let row = "";
    for (const ch of String(s)) { if (ctx.measureText(row + ch).width > maxWidth && row) { rows.push(row); row = ch; } else row += ch; }
    if (row) rows.push(row); return rows;
  };
  text("술깝", 50, "center"); y += 55;
  for (const row of wrap(record.occasion || "우리의 술자리", 545, 28)) { text(row, 28, "center"); y += 38; }
  y += 10;
  text(record.date, 22); text(`${record.people}명`, 22, "right"); y += 20; line();
  text("음주량 기준 추정", 24, "center"); y += 60;
  text(rankLabel(record), 63, "center", undefined, "#244b3d"); y += 35;
  text(rankCaption(record), 20, "center"); y += 24;
  text("평소 1회 음주량 기준 / 2016–2018 자료", 18, "center"); y += 8;
  line(); text("품목", 23); text("수량", 23, "center", 374); text("청구 시간", 23, "right"); y += 16; line();
  const itemMinutes = allocateLifeMinutes(record);
  for (const [index, i] of record.items.entries()) {
    const rows = wrap(i.name, 255, 23);
    text(rows[0], 23); text(`${i.quantity}${i.unit}`, 21, "center", 374);
    text(formatTime(itemMinutes[index]), 21, "right");
    y += 29;
    for (const row of rows.slice(1)) { text(row, 23); y += 29; }
    const detail = `${i.container === "pet" ? "페트병 " : ""}${i.type === "highball" ? `${i.spirit} 원액 ` : ""}${i.volume}ml · ${i.abv}%${Number(i.left) ? ` · 남김 ${i.left}${i.unit}` : ""}`;
    for (const row of wrap(detail, 545, 19)) { text(row, 19, "left", undefined, "#70756f"); y += 26; }
    y += 12;
  }
  line(); text("전체 순수알코올", 23); text(`${record.total.toFixed(1)}g`, 23, "right"); y += 34;
  text("인당 추정 순수알코올", 23); text(`${record.personal.toFixed(1)}g`, 23, "right"); y += 32;
  text(`전체 음주량을 ${record.people}명으로 나눈 추정값`, 19); y += 20; line();
  text("총 청구액", 29); y += 57;
  const bill = `수명 −${formatTime(record.minutes)}`; let billSize = 43;
  ctx.font = `${billSize}px ${font}`;
  while (ctx.measureText(bill).width > 552 && billSize > 22) { billSize--; ctx.font = `${billSize}px ${font}`; }
  text(bill, billSize, "right"); y += 46;
  text("결제 수단", 23); text("나의 시간", 23, "right"); y += 26; line();
  for (const row of wrap(`${RANK_NOTE}. 최대 주량의 순위가 아닙니다. 95g 이상은 외삽, 0.1%는 모형의 표시 하한입니다. 출처: Lee & Jang (2021), doi:10.3390/ijerph18126433. ${NOTICE}`, 545, 20)) { text(row, 20, "left", undefined, "#70756f"); y += 28; }
  y += 16; commands.push({ barcode: true, y }); y += 65;
  text("SULKKAP / THANK YOU", 20, "center"); y += 44;
  canvas.height = y + 10; ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fefefc"; ctx.fillRect(0, 0, 640, y);
  // 작은 점으로만 질감을 더합니다. 다운로드 이미지에는 투명한 톱니가 남습니다.
  ctx.fillStyle = "rgba(70,70,70,0.035)";
  let seed = 12;
  for (let k = 0; k < 11000; k++) { seed = (seed * 1664525 + 1013904223) >>> 0; const x = seed % 640; seed = (seed * 1664525 + 1013904223) >>> 0; ctx.fillRect(x, seed % y, 1, 1); }
  ctx.fillStyle = "#fefefc";
  for (let x = 0; x < 640; x += 20) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10, y + 10); ctx.lineTo(x + 20, y); ctx.fill(); }
  for (const c of commands) {
    if (c.line) { ctx.strokeStyle = "#969b96"; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(44, c.y); ctx.lineTo(596, c.y); ctx.stroke(); ctx.setLineDash([]); }
    else if (c.barcode) { let x = 174; ctx.fillStyle = "#303529"; for (let k = 0; k < 48; k++) { const w = [2, 4, 2, 3, 5, 2][k % 6]; ctx.fillRect(x, c.y, w, 39); x += w + 3; } }
    else { ctx.font = `${c.size}px ${c.s === "술깝" ? '"NeoDunggeunmo", monospace' : font}`; ctx.fillStyle = c.color; ctx.textAlign = c.align; ctx.fillText(c.s, c.x, c.y); }
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("이미지 생성 실패")), "image/png"));
}

export default function App({ createLink = createShareLink, analyzeInput = analyzeDrinks } = {}) {
  const [draft] = useState(readDraft);
  const [occasion, setOccasion] = useState(draft.occasion);
  const [draftWarning, setDraftWarning] = useState("");
  const [page, setPage] = useState(() => new URLSearchParams(window.location.search).has("share") ? 5 : draft.page);
  const [people, setPeople] = useState(draft.people);
  const [items, setItems] = useState(draft.items);
  const [narrative, setNarrative] = useState(draft.narrative);
  const [inputStatus, setInputStatus] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const analysisLock = useRef(false);
  const analysisRequest = useRef(null);
  const [analysisSeconds, setAnalysisSeconds] = useState(0);
  useEffect(() => {
    if (!analyzing) return;
    const started = Date.now();
    const clock = setInterval(() => setAnalysisSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(clock);
  }, [analyzing]);
  useEffect(() => () => {
    analysisRequest.current?.abort();
    analysisRequest.current = null;
  }, []);
  const [examplePending, setExamplePending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [entryEditor, setEntryEditor] = useState(null);
  const [editorError, setEditorError] = useState("");
  const [error, setError] = useState("");
  const [record, setRecord] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [grain, setGrain] = useState("");
  const [fontStatus, setFontStatus] = useState("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [friendMessage,setFriendMessage]=useState("");
  const [cloudStatus,setCloudStatus]=useState("");
  const [chosenMissions, setChosenMissions] = useState(["meal"]);
  const [shareStatus, setShareStatus] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [preparedLink, setPreparedLink] = useState(null);
  const [manualCopy, setManualCopy] = useState(false);
  const [shared, setShared] = useState(null);
  const [checked, setChecked] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const shareLock = useRef(false);
  const linkCache = useRef(new Map());
  const [imageBlob, setImageBlob] = useState(null);
  const receiptRef = useRef(null);
  const headingRef = useRef(null);
  const sheetRef = useRef(null);
  const openerRef = useRef(null);
  const editorRef = useRef(null);
  const addRef = useRef(null);
  const authRef = useRef(null);
  const [authUser, setAuthUser] = useState(() => readAuthSession()?.user || null);
  const [authBusy, setAuthBusy] = useState(false);
  const myReturnPage = useRef(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authShowPassword, setAuthShowPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const activeItems = items;
  const unresolved = items.filter(i => itemError(i));
  const valid = activeItems.length > 0 && activeItems.length <= 60 && activeItems.every((i) => !itemError(i));
  const total = valid ? activeItems.reduce((n, i) => n + gramsOf(i), 0) : 0;

  useEffect(() => {
    if (shared || new URLSearchParams(window.location.search).has("share")) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 4, occasion, people, items, narrative, page: page === 6 ? myReturnPage.current : page === 4 ? 3 : page }));
      setDraftWarning("");
    } catch { setDraftWarning("이 브라우저에서는 작성 내용을 저장할 수 없어요. 새로고침하면 입력이 사라질 수 있어요."); }
  }, [occasion, people, items, narrative, page, shared]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("share");
    if (id === null) return;
    let alive = true;
    setLoadError(""); setPage(5);
    readShare(id).then(data => {
      if (!alive) return;
      setShared(data); setChecked(readChecks(id, data.missions)); setRecord(data.receipt); setPrinting(true); setPage(4);
    }).catch(e => { if (alive) setLoadError(e.message || "연결하지 못했어요. 인터넷 연결을 확인해주세요."); });
    return () => { alive = false; };
  }, [retry]);
  useEffect(() => {
    setGrain(makeGrain());
    let alive = true;
    const cleanups = [];
    const loadFont = (id, href, family) => new Promise((resolve, reject) => {
      let link = document.querySelector(`link[data-sulkkap-font="${id}"]`);
      const check = async () => {
        try {
          const faces = await document.fonts.load(`24px "${family}"`, "술깝 영수증");
          if (faces.length) resolve(); else reject(new Error("Font unavailable"));
        } catch (e) { reject(e); }
      };
      const fail = () => reject(new Error("Font stylesheet unavailable"));
      if (!link) { link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; link.dataset.sulkkapFont = id; }
      link.addEventListener("load", check); link.addEventListener("error", fail);
      cleanups.push(() => { link.removeEventListener("load", check); link.removeEventListener("error", fail); });
      if (!link.isConnected) document.head.appendChild(link); else if (link.sheet) check();
    });
    Promise.all([loadFont("logo", LOGO_FONT_CSS, "NeoDunggeunmo"), loadFont("receipt-serif", RECEIPT_FONT_CSS, "Noto Serif KR")])
      .then(() => { if (alive) setFontStatus("ready"); })
      .catch(() => { if (alive) setFontStatus("error"); });
    const timeout = setTimeout(() => { if (alive) setFontStatus((v) => v === "loading" ? "error" : v); }, 15000);
    return () => { alive = false; clearTimeout(timeout); cleanups.forEach((clean) => clean()); };
  }, []);
  useEffect(() => {
    let alive=true;
    restoreAuthSession().then(s=>{if(alive)setAuthUser(s?.user||null)}).catch(()=>{if(alive)setAuthError('로그인 상태를 확인하지 못했어요.');});
    const {data}=db.auth.onAuthStateChange((_event,s)=>{if(alive)setAuthUser(s&&!s.user.is_anonymous?s.user:null)});
    return()=>{alive=false;data.subscription.unsubscribe()};
  },[]);
  useEffect(()=>{if(!authUser)return;let alive=true;finishLogin().then(()=>{if(alive)setCloudStatus('로그인 전 기록까지 계정에 연결했어요.')}).catch(e=>{if(alive)setCloudStatus('기록 연결을 완료하지 못했어요. 마이페이지에서 새로고침해주세요. '+e.message)});return()=>alive=false},[authUser?.id]);
  useEffect(()=>{if(!record||shared)return;let alive=true;try{queueReceipt(record);setCloudStatus('기록을 보관하는 중…');syncReceipts().then(()=>{if(alive)setCloudStatus(authUser?'내 계정에 보관했어요.':'이 브라우저의 게스트 기록으로 보관했어요. 로그인하면 이어받을 수 있어요.')}).catch(()=>{if(alive)setCloudStatus('이 브라우저에 보관했어요. 서버 저장은 아직 완료되지 않았어요.')});}catch{setCloudStatus('기록을 보관하지 못했어요. 영수증 이미지를 저장해주세요.')}return()=>alive=false},[record?.id,shared?.id]);
  useLayoutEffect(() => {
    if (page !== 4 || !receiptRef.current) return;
    const paper = receiptRef.current;
    const update = () => {
      const height = paper.offsetHeight + 30;
      paper.parentElement.style.setProperty("--paper-height", `${height}px`);
      paper.parentElement.style.setProperty("--first-feed", `${Math.min(112, height * 0.2)}px`);
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(paper);
    return () => observer.disconnect();
  }, [page, record, fontStatus]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    headingRef.current?.focus({ preventScroll: true });
  }, [page]);
  useEffect(() => {
    if (page !== 4) return;
    const t = setTimeout(() => setPrinting(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1950);
    return () => clearTimeout(t);
  }, [page, record]);
  useEffect(() => {
    if (!record) return;
    let alive = true;
    setImageBlob(null);
    receiptImage(record).then((blob) => { if (alive) setImageBlob(blob); }).catch(() => {});
    return () => { alive = false; };
  }, [record, fontStatus]);
  useEffect(() => {
    if (!sheetOpen && !addOpen && !entryEditor && !authOpen) return;
    const modal = sheetOpen ? sheetRef.current : addOpen ? addRef.current : entryEditor ? editorRef.current : authRef.current;
    const old = document.body.style.overflow; document.body.style.overflow = "hidden";
    const previousFocus = document.activeElement;
    modal?.querySelector("button,input")?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !shareLock.current && !authBusy) {
        setSheetOpen(false); setAddOpen(false); setEntryEditor(null); setAuthOpen(false);
      }
      if (e.key !== "Tab") return;
      const nodes = Array.from(modal?.querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || []);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = old; document.removeEventListener("keydown", key); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [sheetOpen, addOpen, entryEditor?.item.id, authOpen, authBusy]);
  const move = (next) => { setError(""); setStatus(""); setManualCopy(false); setExamplePending(false); setPage(next); };
  const openMyPage = () => { myReturnPage.current = page === 6 ? myReturnPage.current : page; setAuthError(''); setAuthOpen(false); move(6); };
  const openSavedReceipt = raw => { try { const r=normalizeRecord(raw); window.history.replaceState(null,'',window.location.pathname); setShared(null); setPreparedLink(null); setRecord(r); setPrinting(true); move(4); } catch { setAuthError('저장된 영수증을 확인하지 못했어요.'); } };
  const openAuth = (mode = "login") => {
    setAuthMode(mode);
    setAuthError("");
    setAuthStatus("");
    setAuthShowPassword(false);
    if (!authUser) { setAuthEmail(""); setAuthPassword(""); }
    setAuthOpen(true);
  };
  const closeAuth = () => {
    if (authBusy) return;
    setAuthOpen(false);
    setAuthError("");
    setAuthStatus("");
    setAuthPassword("");
    setAuthShowPassword(false);
  };
  const submitAuth = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !email.includes("@")) { setAuthError("이메일 주소를 확인해주세요."); return; }
    if (password.length < 6) { setAuthError("비밀번호는 6자 이상으로 입력해주세요."); return; }
    setAuthBusy(true); setAuthError(""); setAuthStatus("");
    try {
      const session = authMode === "signup"
        ? await signUpWithPassword(email, password)
        : await signInWithPassword(email, password);
      if (!session?.user) throw new Error("로그인에 실패했어요. 잠시 후 다시 시도해주세요.");
      setAuthUser(session.user);
      setAuthPassword("");
      setAuthShowPassword(false);
      setAuthStatus(authMode === "signup" ? "가입했어요. 이제 로그인된 상태예요." : "로그인했어요.");
      setAuthOpen(false);
    } catch (err) {
      setAuthError(err.message || "잠시 후 다시 시도해주세요.");
    } finally { setAuthBusy(false); }
  };
  const logoutAuth = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthError("");
    try {
      await signOutSession(readAuthSession());
      setAuthUser(null);
      setAuthEmail("");
      setAuthPassword("");
      setAuthMode("login");
      setAuthStatus("로그아웃했어요.");
      setAuthOpen(false); if(page === 6) move(myReturnPage.current);
    } catch {
      setAuthError("로그아웃하지 못했어요. 잠시 후 다시 시도해주세요.");
    } finally { setAuthBusy(false); }
  };
  const changeItem = (id, field, value) => {
    setItems(old => old.map(i => i.id === id ? patchEntry(i, field, value) : i));
  };
  const openEntry = (item, mode = "edit") => { setEditorError(""); setEntryEditor({ mode, item: { ...item } }); setAddOpen(false); };
  const editValue = (field, value) => { setEntryEditor(old => ({ ...old, item: patchEntry(old.item, field, value) })); setEditorError(""); };
  const editUnit = (unit, container = "") => {
    setEntryEditor(old => ({ ...old, item: { ...old.item, unit, container,
      volume: container === "pet" ? "" : defaultVolume(old.item.type, unit),
      defaultFields: [...new Set([...defaultsOf(old.item), "volume"])], edited: true } }));
    setEditorError("");
  };
  const commitEntry = (e) => {
    e.preventDefault();
    const problem = itemError(entryEditor.item);
    if (problem) { setEditorError(problem); return; }
    if (entryEditor.mode === "add" && items.length >= 60) { setEditorError("한 영수증에 항목을 최대 60개까지 넣을 수 있어요."); return; }
    setItems(old => entryEditor.mode === "add" ? [...old, entryEditor.item] : old.map(i => i.id === entryEditor.item.id ? entryEditor.item : i));
    setEntryEditor(null); setInputStatus("");
  };
  const applyExample = () => {
    setNarrative(EXAMPLE_TEXT); setItems(makeExampleItems()); setExamplePending(false);
    setInputStatus("예시를 정리했어요. 하이볼 수량만 알려주세요. 모르는 용량·도수는 기본값을 사용해요."); move(3);
  };
  const tryExample = () => { if (items.length) setExamplePending(true); else applyExample(); };
  const cancelAnalysis = () => {
    const request = analysisRequest.current;
    analysisRequest.current = null;
    request?.abort();
    analysisLock.current = false;
    setAnalyzing(false);
    setInputStatus("분석 대기를 취소했어요. 기억나는 술을 직접 입력해주세요.");
    move(3);
  };
  const organizeInput = async () => {
    if (!analyzeInput || analysisLock.current || !narrative.trim()) return;
    const request = new AbortController();
    analysisRequest.current = request;
    analysisLock.current = true; setAnalyzing(true); setAnalysisSeconds(0); setInputStatus("");
    document.activeElement?.blur();
    let deadline;
    try {
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => {
          reject(Object.assign(new Error("timeout"), { userMessage: ANALYSIS_MESSAGES.TIMEOUT }));
          request.abort();
        }, 16000);
      });
      const result = await Promise.race([analyzeInput({ text: narrative.trim(), people, occasion, signal: request.signal }), timeout]);
      if (analysisRequest.current !== request) return;
      if (!Array.isArray(result?.items) || !result.items.length || result.items.length > 60) throw new Error("invalid");
      const next = result.items.map(raw => {
        const def = definition(raw?.type);
        if (!def) throw new Error("unsupported");
        const item = createItem(def.id);
        item.name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : def.name;
        item.unit = def.units.includes(raw.unit) ? raw.unit : def.units[0];
        item.container = def.id === "beer" && item.unit === "병" && raw.container === "pet" ? "pet" : "";
        item.volume = item.container === "pet" ? 1600 : defaultVolume(def.id, item.unit);
        item.defaultFields = ["volume", "abv"];
        for (const field of ["quantity", "left", "volume", "abv"]) {
          const value = raw[field];
          if (value !== null && value !== undefined && value !== "") {
            if (!["number", "string"].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error("invalid");
            item[field] = Number(value); item.defaultFields = item.defaultFields.filter(f => f !== field);
          } else if (field === "quantity") item.quantity = "";
        }
        if (typeof raw.spirit === "string" && raw.spirit.trim()) item.spirit = raw.spirit.trim().slice(0, 40);
        if (item.quantity !== "" && itemError(item)) throw new Error("invalid");
        item.edited = false; return item;
      });
      setItems(next); move(3); setInputStatus("정리한 내용이 기억과 맞는지 확인해주세요.");
    } catch (error) {
      if (analysisRequest.current !== request) return;
      setInputStatus((error?.userMessage || "분석하지 못했어요. 인터넷 연결과 분석 함수 설정을 확인하거나 직접 입력해주세요.") + (items.length ? " 기존 술 목록은 유지했어요." : " 입력한 문장은 유지했어요."));
    } finally {
      clearTimeout(deadline);
      if (analysisRequest.current === request) {
        analysisRequest.current = null; analysisLock.current = false; setAnalyzing(false);
      }
    }
  };
  const calculate = (e) => {
    e.preventDefault();
    if (!valid) { setError("각 항목의 수량과 세부사항을 확인해주세요."); return; }
    const date = new Date().toLocaleDateString("sv-SE");
    setRecord({ id: uid(), date, occasion: occasion.trim() || "우리의 술자리", people, items: activeItems.map((i) => ({ ...i })), total,
      personal: total / people, minutes: calculateLifeMinutes(total / people), rank: estimatePercentile(total / people) });
    setPrinting(true); move(4);
  };
  const save = async () => {
    setSaving(true); setStatus("");
    try {
      let blob = imageBlob || await receiptImage(record);
      let urlForQR=shared?shareUrl(shared.id):activeLink;
      // Save the receipt without a QR until a working share link exists.
      if(urlForQR)blob=await socialImage(blob,urlForQR,record,false);
      const url = URL.createObjectURL(blob); const a = document.createElement("a");
      a.href = url; a.download = `술깝-${record.date}.png`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000); setStatus("영수증 이미지 저장을 요청했어요.");
    } catch { setStatus("저장하지 못했어요. 다시 눌러주세요."); }
    finally { setSaving(false); }
  };
  const reset = () => {
    if (!window.confirm("입력한 내용을 지우고 처음부터 시작할까요?")) return;
    setOccasion(""); setPeople(1); setItems([]); setNarrative(""); setInputStatus(""); setRecord(null); move(0);
  };
  const linkKey = record ? JSON.stringify([record.id, friendMessage, sheetOpen ? "mission" : "result", sheetOpen ? [...chosenMissions].sort() : []]) : "";
  const activeLink = preparedLink?.key === linkKey ? preparedLink.url : linkCache.current.get(linkKey)?.url || "";
  const shareText = record ? `${sheetOpen ? "우리, 다음엔 이 미션 같이 해볼까?" : "내 술깝은 이 정도. 너는?"}\n[${record.occasion || "우리의 술자리"}]\n음주량 기준 추정 ${rankLabel(record)}\n${RANK_NOTE}\n${friendMessage ? friendMessage + "\n" : ""}${activeLink}\n\n${NOTICE}` : "";
  const openShare = () => { setShareStatus(""); setManualCopy(false); setSheetOpen(true); };
  const copyLink = async () => {
    if (!activeLink) return;
    try { await navigator.clipboard.writeText(activeLink); setShareStatus("복사했어요. 친구와의 대화창에 붙여넣어주세요."); }
    catch { setManualCopy(true); setShareStatus("아래 내용을 선택해서 복사해주세요."); }
  };
  const sendLink = async () => {
    if (shareLock.current) return;
    setShareStatus(""); setManualCopy(false);
    if (!activeLink) {
      shareLock.current = true; setShareBusy(true);
      try {
        let result = linkCache.current.get(linkKey);
        if (!result) {
          result = await createLink({ record, purpose: sheetOpen ? "mission" : "result", missions: sheetOpen ? [...chosenMissions].sort() : [], message: friendMessage });
          linkCache.current.set(linkKey, result);
        }
        setPreparedLink({ key: linkKey, ...result });
        try { await navigator.clipboard.writeText(result.url); setShareStatus("링크를 만들고 복사했어요. 친구에게 붙여넣어 보내세요."); }
        catch { setManualCopy(true); setShareStatus("링크가 준비됐어요. 아래 링크를 복사하거나 보내기 버튼을 눌러주세요."); }
      } catch (e) { setShareStatus(e.message || "링크를 만들지 못했어요. 연결을 확인하고 다시 시도해주세요."); }
      finally { shareLock.current = false; setShareBusy(false); }
      return;
    }
    if (!navigator.share) { await copyLink(); return; }
    shareLock.current = true; setShareBusy(true);
    try { await navigator.share({ title: "술깝 · 당신의 술값 영수증", text: shareText.replace(activeLink, "").trim(), url: activeLink }); setShareStatus("공유를 마쳤어요."); }
    catch (e) { if (e.name !== "AbortError") { setManualCopy(true); setShareStatus("공유창을 열지 못했어요. 링크를 복사해 보내주세요."); } }
    finally { shareLock.current = false; setShareBusy(false); }
  };
  const toggleMission = (id) => {
    const next = checked.includes(id) ? checked.filter(v => v !== id) : [...checked, id];
    setChecked(next);
    try { localStorage.setItem(`sulkkap:missions:${shared.id}`, JSON.stringify(next)); setStatus(""); }
    catch { setStatus("이 브라우저에서 저장할 수 없어요. 창을 닫으면 체크가 사라질 수 있어요."); }
  };
  const startOwn = () => {
    const url = new URL(window.location.href); url.searchParams.delete("share");
    window.history.replaceState(null, "", url); setShared(null); setRecord(null); setLoadError(""); setSheetOpen(false); move(0);
  };
  const shareControls = <>
    {shareStatus && <p className="status" role="status">{shareStatus}</p>}
    {activeLink && <div className="share-link-box"><label className="message-label" htmlFor="ready-share-link">친구에게 보낼 링크</label><input id="ready-share-link" readOnly value={activeLink} onFocus={e=>e.target.select()}/><div className="share-link-actions"><button className="link-button" onClick={copyLink} disabled={shareBusy}>링크 복사</button><a className="link-button" href={activeLink} target="_blank" rel="noreferrer">받는 화면 미리보기 ↗</a></div></div>}
    {manualCopy && <textarea aria-label="복사할 공유 링크" readOnly value={shareText} onFocus={e => e.target.select()} />}
    {activeLink && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) && <p className="footnote">지금 링크는 이 컴퓨터에서만 열려요. 친구에게 보내려면 사이트를 배포한 뒤 새 링크를 만들어주세요.</p>}
  </>;
  const fontWarning = fontStatus === "error" ? <p className="font-warning">영수증 글꼴을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해주세요.</p> : null;
  const heading = (title, sub) => <><div className="step-dots" aria-label={`${page}/3 단계`}>{[1, 2, 3].map(n => <i key={n} className={n <= page ? "on" : ""} />)}</div><h1 tabIndex={-1} ref={headingRef}>{title}</h1>{sub && <p className="sub">{sub}</p>}</>;


  return <div className="sk" style={{ "--grain": grain ? `url("${grain}")` : "none" }}>
    <style>{CSS + `.sk .friend-note{border-left:3px solid var(--green);padding:14px 18px;margin:18px 0 24px;background:#f5f6f4}.sk .friend-note small{font-size:12px;color:var(--muted)}.sk .friend-note p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:18px;line-height:1.6;margin:8px 0 0}.sk .field textarea{width:100%;font:inherit;padding:12px;border:1px solid var(--line);background:transparent;resize:vertical}.sk .care-section form{margin-top:20px}`}</style>
    <header className="sk-header">
      {page === 6 ? <button className="sk-back" onClick={()=>move(myReturnPage.current)}>← 돌아가기</button> : page > 0 && !shared && page !== 5 ? <button className="sk-back" disabled={analyzing} onClick={() => move(page === 4 ? 3 : page - 1)}>← 이전</button> : <span aria-hidden="true" />}
      <div className="sk-logo mono">술깝</div>
      <button type="button" className={`sk-auth${authUser ? " sk-auth-email" : ""}`} onClick={() => authUser ? openMyPage() : openAuth()} aria-label={authUser ? "마이페이지" : "로그인"} aria-current={page === 6 ? "page" : undefined}>
        {authUser ? "마이페이지" : "로그인"}
      </button>
    </header>

    {page === 6 && (authUser ? <MyPage key={authUser.id} user={authUser} onOpen={openSavedReceipt} onStart={startOwn} onLogout={logoutAuth} busy={authBusy} error={authError} formatTime={formatTime}/> : <main className="sk-stage"><h1>내 기록을 보려면</h1><p>로그인하고 영수증과 약속을 이어서 만나보세요.</p><button className="primary" onClick={()=>openAuth()}>로그인</button></main>)}
    {page === 0 && <main className="sk-stage home" key="home">
      <p className="eyebrow">당신의 술값 영수증</p>
      <h1 ref={headingRef} tabIndex={-1}>그날 마신 양,<br />상위 <em>몇 %</em>일까요?</h1>
      <p className="sub">당신의 신체에 청구된<br />진짜 술값도 확인해보세요.</p>
      <MiniReceipt />
      <div className="actions"><button className="primary" onClick={() => move(1)}>시작하기</button><p>한 번의 술자리에서 함께 마신 전체 양을 입력해요.<br />인원수로 나눠 인당 음주량을 추정합니다.</p></div>
      {fontWarning}
    </main>}

    {page === 5 && <main className="sk-stage"><h1 ref={headingRef} tabIndex={-1}>당신의 술값 영수증</h1>{loadError ? <><p role="alert">{loadError}</p><button className="primary" onClick={() => setRetry(n => n + 1)}>다시 시도</button><button className="link-button" onClick={startOwn}>내 술깝도 확인하기</button></> : <p role="status">영수증을 불러오고 있어요…</p>}</main>}

    {page === 1 && <main className="sk-stage" key="occasion">
      {heading(<>어떤<br />술자리였나요?</>, "함께한 친구가 알아볼 이름을 붙여주세요.")}
      <form onSubmit={e => { e.preventDefault(); move(2); }} className="occasion-form">
        <label className="field">술자리 이름<input autoComplete="off" maxLength={40} placeholder="예: 신입생 MT" value={occasion} onChange={e => setOccasion(e.target.value)} /></label>
        <p className="hint">비워두면 ‘우리의 술자리’로 기록돼요.</p>
        <h2 className="people-heading">몇 명이서 마셨나요?</h2>
        <div className="counter"><button type="button" aria-label="인원 1명 줄이기" disabled={people === 1} onClick={() => setPeople(n => Math.max(1, n - 1))}>−</button>
          <div className="people-number" aria-live="polite">{people}<span>명</span></div>
          <button type="button" aria-label="인원 1명 늘리기" disabled={people >= 10000} onClick={() => setPeople(n => n + 1)}>+</button></div>
        <div className="actions"><button className="primary" type="submit">마신 술 입력하기</button></div>
        <p className="footnote">함께 마신 전체 양을 인원수로 나눠 계산해요. 실제로 각자 마신 양은 다를 수 있어요.</p>
      </form>
    </main>}

    {page === 2 && <main className="sk-stage input-stage narrative-stage" key="narrative">
      {heading(<>그날, 얼마나<br />마셨나요?</>, "친구에게 말하듯 자연스럽게 적어주세요.")}
      <div className="input-context"><span>{occasion.trim() || "우리의 술자리"} · {people}명</span><button className="link-button" disabled={analyzing} onClick={() => move(1)}>수정</button></div>
      <section className="natural-input" aria-labelledby="natural-title">
        <label id="natural-title" htmlFor="drink-story">함께 마신 전체 양</label>
        <textarea id="drink-story" disabled={analyzing} maxLength={1200} value={narrative} placeholder="소주 3병이랑 맥주 큰 페트병 반 정도 마셨어." onChange={e => { setNarrative(e.target.value); setExamplePending(false); setInputStatus(""); }} />
        <button type="button" className="primary organize-button" aria-busy={analyzing} disabled={!analyzeInput || !narrative.trim() || analyzing} onClick={organizeInput}>{analyzing ? <><span className="analysis-spinner" aria-hidden="true" /> 분석 중 · {analysisSeconds}초</> : inputStatus ? "다시 정리하기" : "입력한 내용 정리하기"}</button>
        {analyzing && <div className="analysis-feedback" role="status">
          <strong>{analysisSeconds < 5 ? "술 종류와 수량을 정리하고 있어요." : "응답이 평소보다 늦어지고 있어요."}</strong>
          <p>{analysisSeconds < 5 ? "완료되면 확인 화면으로 자동 이동해요." : "최대 16초까지 기다린 뒤 연결 상태를 안내할게요."}</p>
          <button type="button" className="secondary" onClick={cancelAnalysis}>기다리지 않고 직접 입력하기</button>
        </div>}
        {!analyzing && inputStatus && <div className="analysis-feedback analysis-failed" role="alert"><strong>분석 결과를 확인해주세요</strong><p>{inputStatus}</p><button type="button" className="secondary" onClick={() => move(3)}>항목으로 직접 입력하기</button></div>}
        <div className="input-alternatives"><button className="link-button" disabled={analyzing} onClick={tryExample}>예시로 체험하기</button><button className="link-button" disabled={analyzing} onClick={() => move(3)}>{items.length ? "기존 술 목록 확인하기" : "항목으로 직접 입력하기"}</button></div>
        {!analyzeInput && <p className="demo-note">입력 분석 API 연결 전이에요. 예시로 화면을 체험하거나 항목으로 직접 입력할 수 있어요.</p>}
        {analyzeInput && items.length > 0 && <p className="demo-note">다시 정리하면 기존 목록을 새 입력 내용으로 바꿔요.</p>}
        {examplePending && <div className="replace-example" role="group" aria-label="예시로 교체 확인"><p>현재 술 목록을 예시로 바꿀까요?</p><div><button className="secondary" onClick={() => setExamplePending(false)}>유지하기</button><button className="primary" onClick={applyExample}>예시로 바꾸기</button></div></div>}
      </section>
      <p className="footnote">기억나는 만큼 적어주세요. 모르는 용량·도수는 기본값으로 추정하고, 다음 화면에서 바꿀 수 있어요. 정리하기를 누르면 입력 문장이 AI 분석을 위해 Groq로 전송돼요.</p>
    </main>}

    {page === 3 && <main className="sk-stage input-stage review-stage" key="review">
      {heading("이렇게 마신 게 맞나요?", "다른 부분은 눌러 바꿔주세요.")}
      <div className="input-context"><span>{occasion.trim() || "우리의 술자리"} · {people}명</span><button className="link-button" onClick={() => move(1)}>수정</button></div>
      {narrative && <details className="original-story"><summary>내가 적은 내용</summary><p>{narrative}</p><button className="link-button" onClick={() => move(2)}>입력 문장 바꾸기</button></details>}
      {inputStatus && <p className="sr-only" role="status">{inputStatus}</p>}
      <form className="input-list-form" onSubmit={calculate} noValidate>
        <div className="input-list-head"><h2>마신 술 목록 <small>{items.length}</small></h2><button type="button" className="link-button" disabled={items.length >= 60} onClick={() => setAddOpen(true)}>＋ 술 추가</button></div>
        {!items.length && <div className="empty-drinks"><p>마신 술을 하나씩 추가해도 괜찮아요.</p><button type="button" className="secondary" onClick={() => setAddOpen(true)}>술 추가하기</button></div>}
        {items.map(i => <section className="compact-drink" key={i.id} aria-label={`${i.name} 입력 항목`}>
          <div className="compact-main">
            <button type="button" className="entry-info" aria-label={`${i.name} 용량·도수 수정`} onClick={() => openEntry(i)}>
              <strong>{i.name || "기타 술"}</strong>
              <small>{i.type === "highball" ? "원액 " : i.container === "pet" ? "페트병 " : ""}{i.volume === "" ? "용량 미확인" : `${i.volume}ml`} · {i.abv === "" ? "도수 미확인" : `${i.abv}%`}</small>
              <small className="entry-edit-label">{defaultsOf(i).length ? "기본값 · " : ""}{Number(i.left) > 0 ? `${i.left}${i.unit} 남김 · ` : ""}수정</small>
            </button>
            <div className="compact-quantity"><button type="button" aria-label={`${i.name} 수량 줄이기`} disabled={Number(i.quantity) <= 1} onClick={() => changeItem(i.id, "quantity", Math.round((Number(i.quantity) - 1) * 100) / 100)}>−</button><label><span className="sr-only">{i.name} 전체 수량</span><input aria-label={`${i.name} 전체 수량`} type="number" inputMode="decimal" min="0.01" step="any" placeholder="?" value={i.quantity} onChange={e => changeItem(i.id, "quantity", e.target.value)} /></label><span>{i.unit}</span><button type="button" aria-label={`${i.name} 수량 늘리기`} onClick={() => changeItem(i.id, "quantity", Math.round((Number(i.quantity) + 1) * 100) / 100)}>+</button></div>
          </div>
          {missingPrompt(i) && <button type="button" className="missing-entry" onClick={() => openEntry(i)}>{missingPrompt(i)} <span>확인 →</span></button>}
        </section>)}
        {items.length > 0 && <button type="button" className="add-more" disabled={items.length >= 60} onClick={() => setAddOpen(true)}>＋ 술 추가</button>}
        <p className="input-help">절반은 수량에 0.5로 입력할 수 있어요.<br />용량·도수를 모르면 기본값을 사용해도 돼요. 추정값이라 실제 음주량과 다를 수 있어요.</p>
        <div className="input-footer">
          {unresolved.length > 0 && <button type="button" className="unresolved-link" onClick={() => openEntry(unresolved[0])}>확인할 항목 {unresolved.length}개 · 첫 항목 확인하기 →</button>}
          <p>{people}명이 함께 마신 전체 양을 입력해주세요.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" type="submit" disabled={!valid}>이대로 영수증 발급하기</button>
        </div>
      </form>
    </main>}

    {page === 4 && record && <main className="sk-stage result" key={`result-${record.id}`}>
      <p className="result-caption" ref={headingRef} tabIndex={-1} aria-live="polite">{printing ? "영수증을 출력하고 있어요." : shared ? "친구가 보낸 그날의 영수증" : "당신에게 청구된 술값입니다."}</p>
      {shared?.message && <aside className="friend-note"><small>친구가 남긴 한마디</small><p>{shared.message}</p></aside>}
      {shared && <section className="shared-intro"><span className="eyebrow">한 장으로 남긴 그날의 술자리</span><h1>술값은 냈는데,<br /><em>술깝</em>은 얼마였을까?</h1><p>친구의 영수증이 도착했어요.<br />나는 어떤 영수증을 받게 될까요?</p><button className="primary" onClick={startOwn}>나도 영수증 받아보기 ↗</button></section>}
      <div className="printer"><div className="slot" aria-hidden="true" /><div className="paper-window">
        <article ref={receiptRef} className="paper receipt" aria-label="술깝 결과 영수증" onAnimationEnd={(e) => { if (e.animationName === "feed-paper") setPrinting(false); }}>
          <div className="receipt-head"><div className="brand">술깝</div><p className="occasion-name">{record.occasion || "우리의 술자리"}</p></div>
          <div className="row"><span>{record.date}</span><span>{record.people}명</span></div>
          <div className="rank-block"><p>음주량 기준 추정</p><div className="rank">{rankLabel(record)}</div><small>{rankCaption(record)}</small><small>평소 1회 음주량 기준</small></div>
          <table><thead><tr><th>품목</th><th>수량</th><th>청구 시간</th></tr></thead><tbody>{record.items.map((i, index) => <tr key={i.id}><td>{i.name}<small>{i.container === "pet" ? "페트병 " : ""}{i.type === "highball" ? `${i.spirit} 원액 ` : ""}{i.volume}ml / {i.abv}%{Number(i.left) > 0 && <> / 남김 {i.left}{i.unit}</>}</small></td><td>{i.quantity}{i.unit}</td><td>{formatTime(allocateLifeMinutes(record)[index])}</td></tr>)}</tbody></table>
          <hr className="rule" /><div className="alcohol"><div className="row"><span>전체 순수알코올</span><span>{record.total.toFixed(1)}g</span></div><div className="row"><span>인당 추정 순수알코올</span><span>{record.personal.toFixed(1)}g</span></div></div>
          <p className="receipt-note">전체 음주량을 {record.people}명으로 나눈 추정값<br />품목 수량은 전체 / 청구 시간은 인당</p>
          <hr className="rule" /><div className="total-label">총 청구액</div><div className="total">수명 −{formatTime(record.minutes)}</div>
          <div className="row"><span>결제 수단</span><span>나의 시간</span></div><Barcode /><ReceiptQR url={shared?shareUrl(shared.id):activeLink}/><div className="serial">SULKKAP / THANK YOU</div>
        </article>
      </div></div>
      {shared ? <>
        {shared.social && <Room id={shared.id} minutes={record.minutes} formatTime={formatTime}/>}{!shared.social && shared.purpose === "mission" && <section className="care-section"><h2>수명 회복하기</h2><p>친구와 함께 미션을 마쳤다면 체크해주세요.<br />총 복원 시간은 청구 수명까지만 적용돼요.</p>
          <MissionChoices available={shared.missions} checked={checked} onToggle={toggleMission} />
          <div className="recovered" aria-live="polite"><p>돌려받은 수명</p><strong className="recovery-total">+{formatTime(recoveredMinutes(record, checked))}</strong><p>남은 청구 수명 {formatTime(record.minutes - recoveredMinutes(record, checked))}</p></div>
          <p className="footnote">체크는 이 브라우저에만 저장돼요. 친구에게 전송되지 않으며, 체크를 해제하면 복원 시간도 되돌아가요.</p>
        </section>}
        <section className="shared-nudge"><h2>이번엔 내 차례.</h2><p>그날의 술과 인원만 적으면<br />나만의 영수증이 완성돼요.</p><button className="primary" onClick={startOwn}>내 술깝 확인하기 →</button><small>가입 없이 시작 · 친구에게 공유까지</small></section><button className="secondary" onClick={save} disabled={saving}>{saving ? "저장 중…" : "친구의 영수증 이미지 저장"}</button>
      </> : <>
        <label className="field">친구에게 한마디 <small>(선택)</small><textarea maxLength={160} rows={2} value={friendMessage} onChange={e=>setFriendMessage(e.target.value)} placeholder="다음엔 술 말고 맛있는 거 먹자."/></label>
        <section className="share-spotlight"><small>MY RECEIPT, YOUR TURN</small><h2>내 술깝은 이 정도. 너는?</h2><p>한 장의 영수증으로 그날의 이야기를 꺼내봐요.</p><button className="primary" onClick={sendLink} disabled={printing || shareBusy}><ShareIcon />{shareBusy ? "링크 만드는 중…" : activeLink ? "친구에게 보내기" : "내 술깝 공유하기"}</button>{!sheetOpen && shareControls}</section>
        <section className="recovery-invite"><h2>그날 함께한 친구와</h2><p>같이 할 미션을 고르고, 청구된 수명을 돌려받아요.</p>
          <button className="primary recovery-main" onClick={openShare} ref={openerRef} disabled={printing || shareBusy}><ShareIcon />친구와 수명 복구하기<span aria-hidden="true">→</span></button>
        </section>
        <button className="link-button save-button" onClick={save} disabled={saving}>{saving ? "저장 중…" : "영수증 이미지 저장"}</button>
        {activeLink&&<><a className="secondary" style={{display:'block',textAlign:'center'}} href={activeLink}>공유 화면에서 친구와 약속 확인하기</a><button className="secondary" disabled={saving} onClick={async()=>{setSaving(true);try{const b=await socialImage(imageBlob||await receiptImage(record),activeLink,record,true);const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='술깝-스토리.png';a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);setStatus('스토리 이미지를 저장했어요. SNS에서 링크 스티커에 공유 링크를 붙여주세요.');}catch{setStatus('스토리 이미지를 저장하지 못했어요.')}finally{setSaving(false)}}}>인스타 스토리 이미지 저장</button><button className="link-button" onClick={copyLink}>카카오톡 등에 보낼 링크 복사</button></>}
        <p className="footnote" role="status">{cloudStatus}</p>
        <div className="edit-actions"><button className="link-button" onClick={() => move(3)}>입력 수정하기</button><button className="link-button" onClick={reset}>다시 계산하기</button></div>
      </>}
      {status && <p className="status" role="status">{status}</p>}
      <details className="criteria"><summary>비교·환산 기준 보기</summary><p>순수알코올(g) = 마신 수량 × 단위당 용량(ml) × 도수 ÷ 100 × 0.789. 남긴 수량을 제외하고 전체를 인원수로 나눕니다. 하이볼은 원액만 계산합니다.</p><p>비교 기준은 국민건강영양조사 2016–2018을 분석한 Lee·Jang(2021)의 표 1에 실린 성인 음주자 전체의 평소 1회 음주량 분포입니다. 모든 한국인·대학생·최대 주량의 순위를 뜻하지 않습니다. 가장 많이 마신 날을 입력하면 평소 음주량과의 차이 때문에 순위가 높게 나올 수 있습니다.</p>
        <p>원자료 분율: 1–2잔 32.5%, 3–4잔 20.6%, 5–6잔 15.5%, 7–9잔 16.6%, 10잔 이상 14.9%. 논문의 정의에 따라 1잔=순수알코올 10g으로 환산하고, 반올림으로 100.1%가 된 합계를 100%로 정규화했습니다.</p>
        <p>구간 경계를 0·25·45·65·95g으로 두고 구간 안에서는 균등하게 분포한다고 가정해 선형 보간합니다. 인당 95g 이상은 마지막 두 경계의 감소율을 연장하는 지수 모형을 사용합니다. 이 상단 모형은 논문에서 검증한 분포가 아닙니다.</p>
        <p>상위 비율은 정수로 반올림하되 0% 대신 최소 1%로 표시합니다. 모형값이 0.1% 이하가 되는 약 {Math.ceil(RANK_FLOOR_GRAMS)}g 이상에서는 0.1%로 고정합니다. 실제 상위 0.1%가 확인됐다는 뜻이 아니며, 정수 표시는 1% 단위 정확도를 보장하지 않습니다. 음주량 0g은 비교에서 제외합니다.</p>
        <p><a href={RANK_SOURCE} target="_blank" rel="noreferrer">통계 출처 · Lee &amp; Jang (2021), 표 1</a></p>
        <p>청구 수명은 인당 순수알코올의 첫 30g에는 g당 1분, 다음 30g에는 g당 2분, 다음 40g에는 g당 3분, 100g을 초과한 양에는 g당 4분을 더하는 게임 규칙입니다. 총액을 분 단위로 반올림하고 품목별 알코올 비중으로 나눠 표시합니다. 품목별 청구 시간의 합계는 총 청구액과 같습니다. 연구에 기반한 수명 추정치가 아닙니다.</p><p>여행·콘서트·캠핑은 각각 10시간, 함께하는 외출·식사는 각각 1시간, 일상 속 교류는 각각 30분을 복원하는 게임 규칙입니다. 미션 선택 개수에는 제한이 없고, 완료한 미션의 보상을 합산하되 원래 청구 시간을 넘지 않습니다. 표시된 보상은 게임에서 정한 값이며 활동 시간이나 건강 효과를 뜻하지 않습니다. 복원은 실제 수행 여부를 검증하지 않습니다. 새 공유 링크의 완료 상태는 서버에 저장되어 참여자에게 함께 표시됩니다. 예전 링크는 브라우저에만 저장됩니다.</p></details>
      <p className="footnote">{NOTICE}</p>{fontWarning}
    </main>}

    {addOpen && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setAddOpen(false); }}><section className="sheet" ref={addRef} role="dialog" aria-modal="true" aria-labelledby="add-title"><div className="sheet-handle" /><div className="sheet-head"><h2 id="add-title">무슨 술을 추가할까요?</h2><button aria-label="닫기" onClick={() => setAddOpen(false)}>×</button></div><div className="drink-grid">{DRINKS.map(d => <button key={d.id} className="drink-choice" onClick={() => openEntry(createItem(d.id), "add")}>{d.name}</button>)}</div><p className="footnote">용량·수량을 확인한 뒤 목록에 추가해요.</p></section></div>}
    {entryEditor && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEntryEditor(null); }}><section className="sheet entry-sheet" ref={editorRef} role="dialog" aria-modal="true" aria-labelledby="entry-title"><div className="sheet-handle" /><div className="sheet-head"><h2 id="entry-title">{entryEditor.item.name || "기타 술"} {entryEditor.mode === "add" ? "추가" : "수정"}</h2><button aria-label="닫기" onClick={() => setEntryEditor(null)}>×</button></div>
      <form onSubmit={commitEntry} noValidate>
        {entryEditor.item.type === "other" && <label className="field">술 이름<input maxLength={40} value={entryEditor.item.name} placeholder="예: 매실주" onChange={e => editValue("name", e.target.value)} /></label>}
        {definition(entryEditor.item.type).units.length > 1 && <div className="unit-options" role="group" aria-label="수량 단위">{definition(entryEditor.item.type).units.map(u => <button type="button" key={u} aria-pressed={entryEditor.item.unit === u && entryEditor.item.container !== "pet"} onClick={() => editUnit(u)}>{u}</button>)}{entryEditor.item.type === "beer" && <button type="button" aria-pressed={entryEditor.item.container === "pet"} onClick={() => editUnit("병", "pet")}>페트병</button>}</div>}
        <NumberField label={`함께 마신 전체 수량 (${entryEditor.item.unit})`} value={entryEditor.item.quantity} min={0.01} onChange={v => editValue("quantity", v)} />
        <div className="volume-picker"><label className="volume-label" htmlFor="editor-volume">{entryEditor.item.type === "highball" ? "한 잔에 들어간 원액 (ml)" : `${unitLabel(entryEditor.item)} 전체 용량 (ml)`}</label>
          <div className="volume-options">{(entryEditor.item.container === "pet" ? [1000, 1600, 2000] : volumeOptions(entryEditor.item.type, entryEditor.item.unit)).map(v => <button type="button" key={v} aria-pressed={Number(entryEditor.item.volume) === v} onClick={() => editValue("volume", v)}>{v}ml</button>)}</div>
          <div className="volume-direct"><input id="editor-volume" aria-label="단위당 용량" type="number" min="0.01" step="any" inputMode="decimal" placeholder="직접 입력" value={entryEditor.item.volume} onChange={e => editValue("volume", e.target.value)} /><span>ml</span><small>직접 수정 가능</small></div>
          <button className="link-button default-volume-button" type="button" onClick={() => setEntryEditor(old => ({ ...old, item: { ...old.item, volume: old.item.container === "pet" ? 1600 : defaultVolume(old.item.type, old.item.unit), abv: definition(old.item.type).abv, spirit: old.item.spirit || "위스키", defaultFields: ["volume", "abv"] } }))}>잘 모르겠어요 · 기본값 사용</button>
          <p className="hint">{entryEditor.item.type === "highball" ? "얼음·탄산수를 제외한 원액만 계산해요." : "용량 버튼은 예시예요. 실제 제품을 확인해주세요."}</p>
        </div>
        {entryEditor.item.type === "highball" ? <><label className="field">원액 종류<input maxLength={40} placeholder="예: 위스키" value={entryEditor.item.spirit} onChange={e => editValue("spirit", e.target.value)} /></label><NumberField label="원액 도수 (%)" value={entryEditor.item.abv} max={100} onChange={v => editValue("abv", v)} /><NumberField label="남긴 수량 (잔)" value={entryEditor.item.left} max={Number(entryEditor.item.quantity)} onChange={v => editValue("left", v)} /></> : <details className="editor-details"><summary>도수·남긴 양 · {entryEditor.item.abv === "" ? "도수 미확인" : `${entryEditor.item.abv}%`} · {Number(entryEditor.item.left) ? `${entryEditor.item.left}${entryEditor.item.unit} 남김` : "남긴 양 없음"}</summary><NumberField label="도수 (%)" value={entryEditor.item.abv} max={100} onChange={v => editValue("abv", v)} /><NumberField label={`남긴 수량 (${entryEditor.item.unit})`} value={entryEditor.item.left} max={Number(entryEditor.item.quantity)} onChange={v => editValue("left", v)} /><p className="hint">입력한 수량에서 남긴 수량을 빼요. 반 병을 마셨다면 수량 0.5, 남긴 수량 0으로 입력해도 돼요.</p></details>}
        {defaultsOf(entryEditor.item).length > 0 && <p className="entry-default">{defaultsOf(entryEditor.item).map(v => v === "volume" ? "용량" : "도수").join("·")}는 수정 가능한 기본값이에요.</p>}
        {editorError && <p className="error" role="alert">{editorError}</p>}
        <button className="primary" type="submit">{entryEditor.mode === "add" ? "목록에 추가" : "수정 완료"}</button>
        {entryEditor.mode === "edit" && <button type="button" className="delete-in-editor" onClick={() => { setItems(old => old.filter(i => i.id !== entryEditor.item.id)); setEntryEditor(null); }}>{entryEditor.item.name} 항목 삭제</button>}
      </form>
    </section></div>}

    {draftWarning && !shared && <p className="footnote" role="status" style={{ padding: "0 24px 24px" }}>{draftWarning}</p>}
    {authOpen && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !authBusy) closeAuth(); }}>
      <section className="sheet auth-sheet" ref={authRef} role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2 id="auth-title">{authUser && authMode === "account" ? "내 계정" : authMode === "signup" ? "회원가입" : "로그인"}</h2>
          <button type="button" aria-label="닫기" disabled={authBusy} onClick={closeAuth}>×</button>
        </div>
        <>
          <button className="secondary" type="button" disabled={authBusy} onClick={async()=>{setAuthBusy(true);setAuthError('');try{await googleLogin()}catch(e){setAuthError(e.message);setAuthBusy(false)}}}>Google로 계속하기</button>
          <div className="auth-tabs" role="tablist" aria-label="로그인 방식">
            <button type="button" role="tab" aria-pressed={authMode === "login"} disabled={authBusy} onClick={() => { setAuthMode("login"); setAuthError(""); setAuthStatus(""); }}>로그인</button>
            <button type="button" role="tab" aria-pressed={authMode === "signup"} disabled={authBusy} onClick={() => { setAuthMode("signup"); setAuthError(""); setAuthStatus(""); }}>회원가입</button>
          </div>
          <form onSubmit={submitAuth} noValidate>
            <label className="field">이메일<input type="email" autoComplete="email" inputMode="email" maxLength={120} placeholder="you@example.com" value={authEmail} disabled={authBusy} onChange={e => { setAuthEmail(e.target.value); setAuthError(""); }} /></label>
            <label className="field password-field">비밀번호
              <input type={authShowPassword ? "text" : "password"} autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={6} maxLength={72} placeholder="6자 이상" value={authPassword} disabled={authBusy} onChange={e => { setAuthPassword(e.target.value); setAuthError(""); }} />
              <button type="button" className="password-toggle" aria-label={authShowPassword ? "비밀번호 숨기기" : "비밀번호 보이기"} aria-pressed={authShowPassword} disabled={authBusy} onClick={() => setAuthShowPassword(v => !v)}><EyeIcon open={authShowPassword} /></button>
            </label>
            {authError && <p className="error" role="alert">{authError}</p>}
            {authStatus && <p className="status" role="status">{authStatus}</p>}
            <button className="primary" type="submit" disabled={authBusy}>{authBusy ? "처리 중…" : authMode === "signup" ? "가입하기" : "로그인"}</button>
          </form>
          <p className="auth-switch">
            <button type="button" className="link-button" disabled={authBusy} onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setAuthError(""); setAuthStatus(""); }}>
              {authMode === "signup" ? "이미 계정이 있나요? 로그인" : "계정이 없나요? 회원가입"}
            </button>
          </p>
          <p className="footnote">로그인하면 영수증과 약속을 마이페이지에서 모아볼 수 있어요.</p>
        </>
      </section>
    </div>}
    {sheetOpen && record && <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !shareBusy) setSheetOpen(false); }}>
      <section className="sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby="share-title"><div className="sheet-handle" />
        <div className="sheet-head"><h2 id="share-title">함께할 미션 고르기</h2><button aria-label="닫기" disabled={shareBusy} onClick={() => { setSheetOpen(false); setShareStatus(""); setManualCopy(false); }}>×</button></div>
        <label className="field">영수증 위에 전할 한마디<textarea maxLength={160} rows={2} value={friendMessage} disabled={shareBusy} onChange={e=>setFriendMessage(e.target.value)} placeholder="다음엔 맛있는 거 먹자."/></label><p className="connection-intro">친구와 하고 싶은 미션을 자유롭게 골라주세요.<br />큰 약속부터 오늘 할 수 있는 일까지 있어요.</p>
        <p className="mission-counter" role="status">{chosenMissions.length}개 선택 · 모두 완료하면 최대 {formatTime(recoveredMinutes(record, chosenMissions))}<small>복원 합계는 청구 수명 {formatTime(record.minutes)}까지만 적용돼요.</small></p>
        <MissionChoices checked={chosenMissions} disabled={shareBusy} onToggle={id => { setChosenMissions(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); setShareStatus(""); setManualCopy(false); }} />
        <button className="primary mission-submit" disabled={shareBusy || !chosenMissions.length} onClick={sendLink}><ShareIcon />{shareBusy ? "준비 중…" : activeLink ? "친구에게 미션 보내기" : "미션 링크 만들기"}</button>
        {shareControls}
        <p className="footnote">{NOTICE}</p>
      </section>
    </div>}
  </div>;
}
