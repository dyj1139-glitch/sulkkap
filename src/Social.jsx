import {useEffect,useRef,useState} from 'react';
import {receiptQR} from './qr.js';
import {db,call,ensureGuest,finishLogin,shareUrl} from './social.js';
export function Room({id,minutes,formatTime}){
 const [rows,setRows]=useState([]),[ready,setReady]=useState(false),[error,setError]=useState(''),[title,setTitle]=useState(''),[busy,setBusy]=useState(false),[live,setLive]=useState(false),[retry,setRetry]=useState(0);const loadRef=useRef(()=>{}),sequence=useRef(0),lock=useRef(false),addId=useRef(null);
 useEffect(()=>{let alive=true,channel,timer;setReady(false);setRows([]);setError('');
 const load=async()=>{const seq=++sequence.current;const {data,error:e}=await db.from('sk_missions').select('id,title,minutes,done,revision').eq('room',id).order('id',{ascending:true}).abortSignal(AbortSignal.timeout(15000));if(alive&&seq===sequence.current){if(e)setError('미션을 불러오지 못했어요. 다시 연결해주세요.');else{setRows(data);setReady(true);}}};loadRef.current=load;
 (async()=>{try{await ensureGuest();await call('sk_join_room',{p_id:id});if(!alive)return;await load();channel=db.channel('missions-'+id+'-'+Math.random()).on('postgres_changes',{event:'*',schema:'public',table:'sk_missions',filter:`room=eq.${id}`},load).subscribe(state=>{if(alive){setLive(state==='SUBSCRIBED');if(state==='SUBSCRIBED')void load();}});timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},15000);}catch(e){if(alive)setError(e.message)}})();
 const focus=()=>void load();window.addEventListener('focus',focus);return()=>{alive=false;sequence.current++;clearInterval(timer);if(channel)void db.removeChannel(channel);window.removeEventListener('focus',focus)};
 },[id,retry]);
 const action=async(fn)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();await loadRef.current()}catch(e){setError(e.message);await loadRef.current()}finally{lock.current=false;setBusy(false)}};
 const recovered=Math.min(minutes,rows.filter(x=>x.done).reduce((n,x)=>n+x.minutes,0));
 return <section className="care-section"><h2>우리 같이 할 일</h2><p>친구도 약속을 추가하고 완료할 수 있어요.</p><p role="status" className="footnote">{ready?(live?'친구와 실시간으로 연결됐어요.':'실시간 재연결 중 · 15초마다 확인해요.'):'약속 목록을 연결하고 있어요…'}</p>
 {error&&<p role="alert" className="error">{error} <button className="link-button" onClick={()=>setRetry(x=>x+1)}>다시 연결</button></p>}
 {rows.map(m=><label className="mission-row" key={m.id}><input type="checkbox" checked={m.done} disabled={busy||!ready} onChange={e=>{const done=e.target.checked;void action(()=>call('sk_check_mission',{p_id:m.id,p_done:done,p_revision:m.revision}))}}/><span><strong>{m.title}</strong></span><small>+{formatTime(m.minutes)}</small></label>)}
 {ready&&!rows.length&&<p>첫 번째 약속을 추가해보세요.</p>}
 <form onSubmit={e=>{e.preventDefault();if(!title.trim())return;addId.current??=crypto.randomUUID();void action(async()=>{await call('sk_add_mission',{p_room:id,p_title:title.trim(),p_id:addId.current});setTitle('');addId.current=null})}}><label className="field">우리만의 약속 추가<input value={title} maxLength={80} placeholder="예: 시험 끝나고 떡볶이 먹기" onChange={e=>{setTitle(e.target.value);addId.current=null}}/></label><button className="secondary" disabled={busy||!ready||!title.trim()}>약속 추가 · +30분</button></form>
 <div className="recovered" aria-live="polite"><p>함께 돌려받은 청구 수명</p><strong className="recovery-total">+{formatTime(recovered)}</strong><p>남은 청구 수명 {formatTime(Math.max(0,minutes-recovered))}</p></div><p className="footnote">같은 미션은 한 번만 합산해요. 누구든 체크를 해제할 수 있으며 복원 합계는 원래 청구 수명을 넘지 않아요.</p></section>
}
export function History({onOpen}){const [data,setData]=useState(null),[error,setError]=useState(''),[tick,setTick]=useState(0);useEffect(()=>{let active=true;(async()=>{try{await finishLogin();const d=await call('sk_history');if(active){setData(d);setError('')}}catch(e){if(active)setError(e.message)}})();return()=>active=false},[tick]);return <section><h3>내 영수증</h3>{error&&<p role="alert">{error}<button className="link-button" onClick={()=>setTick(n=>n+1)}>저장 다시 시도</button></p>}{!data&&!error&&<p>기록을 불러오는 중…</p>}{data?.receipts?.map(x=><button className="secondary" key={x.record.id} onClick={()=>onOpen(x.record)}>{x.record.occasion} · {x.record.date}</button>)}{data?.receipts?.length===0&&<p>아직 보관한 영수증이 없어요.</p>}<h3>참여한 약속</h3>{data?.rooms?.map(r=><p key={r.id}><a href={shareUrl(r.id)}>{r.occasion} · {r.purpose==='mission'?'함께한 약속':'공유 영수증'}</a></p>)}</section>}

export function ReceiptQR({url,busy=false,error='',retryToken=0,onRetry}) {
 const [qr,setQr]=useState(null),[qrError,setQrError]=useState('');
 useEffect(()=>{let alive=true;setQr(null);setQrError('');if(url)receiptQR(url).then(result=>{if(alive)setQr(result)}).catch(()=>{if(alive)setQrError('QR 이미지를 만들지 못했어요. 다시 시도해주세요.')});return()=>{alive=false}},[url,retryToken]);
 const local=url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
 return <div className="receipt-qr">
   {qr ? <><img src={qr.dataUrl} width={qr.size} height={qr.size} alt="이 영수증과 약속을 여는 QR 코드"/><p>스캔하면 이 영수증으로 연결돼요.</p><small>{local?'테스트용 주소예요. 친구에게 보낼 때는 배포 주소에서 만들어주세요.':'친구와 함께한 그날, 한 장으로 남겨요.'}</small></>
   : <><p role="status">{busy || (url&&!qrError) ? '공유 QR을 준비하고 있어요…' : '이 영수증을 QR로 남겨요.'}</p>{(error||qrError)&&<p className="qr-error" role="status">{error||qrError}</p>}{!busy&&(!url||qrError)&&onRetry&&<button className="qr-retry" onClick={onRetry}>QR 다시 만들기</button>}</>}
 </div>;
}
export async function socialImage(blob,url,record,story=false) {
 const {dataUrl,modules}=await receiptQR(url);
 const [base,qr]=await Promise.all([createImageBitmap(blob),fetch(dataUrl).then(r=>r.blob()).then(createImageBitmap)]);
 try {
  const c=document.createElement('canvas'), footerSize=modules*Math.max(1,Math.min(5,Math.floor(480/modules)));
  c.width=story?1080:640;c.height=story?1920:base.height+footerSize+122;
  const ctx=c.getContext('2d');ctx.fillStyle='#ecedec';ctx.fillRect(0,0,c.width,c.height);
  if(story){
   ctx.fillStyle='#244b3d';ctx.textAlign='center';ctx.font='bold 54px sans-serif';ctx.fillText('술값은 냈는데, 술깝은 얼마?',540,110);
   ctx.fillStyle='#5f6c60';ctx.font='32px sans-serif';ctx.fillText(record.occasion.slice(0,22),540,170);
   const scale=Math.min(760/base.width,1170/base.height);ctx.drawImage(base,(1080-base.width*scale)/2,220,base.width*scale,base.height*scale);
   const qrSize=modules*Math.max(1,Math.min(5,Math.floor(320/modules)));ctx.imageSmoothingEnabled=false;ctx.drawImage(qr,(1080-qrSize)/2,1430,qrSize,qrSize);ctx.imageSmoothingEnabled=true;
   ctx.fillStyle='#244b3d';ctx.font='bold 37px sans-serif';ctx.fillText('이번엔 내 영수증 받아보기',540,1840);
  }else{
   ctx.drawImage(base,0,0);ctx.fillStyle='#fefefc';ctx.fillRect(0,base.height-10,640,c.height-base.height+10);
   ctx.imageSmoothingEnabled=false;ctx.drawImage(qr,(640-footerSize)/2,base.height+20,footerSize,footerSize);ctx.imageSmoothingEnabled=true;
   ctx.fillStyle='#244b3d';ctx.textAlign='center';ctx.font='22px sans-serif';ctx.fillText('스캔하면 이 영수증으로 연결돼요.',320,base.height+footerSize+66);
   ctx.fillStyle='#6c7665';ctx.font='16px monospace';ctx.fillText('SULKKAP / SEE YOU NEXT TIME',320,base.height+footerSize+99);
  }
  return await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('이미지 저장 실패')),'image/png'));
 }finally{base.close();qr.close();}
}
