-- 새 공동 미션 기능. 기존 sulkkap_shares 테이블/함수는 변경하지 않습니다.
begin;
create table if not exists public.sk_receipts (owner uuid not null references auth.users(id), id text not null, record jsonb not null, created_at timestamptz not null default now(), primary key(owner,id));
create table if not exists public.sk_rooms (id uuid primary key default gen_random_uuid(), owner uuid not null references auth.users(id), receipt jsonb not null, purpose text not null check(purpose in ('result','mission')), message text not null default '' check(length(message)<=160), created_at timestamptz not null default now());
create table if not exists public.sk_members (room uuid references public.sk_rooms(id) on delete cascade, member uuid references auth.users(id), primary key(room,member));
create table if not exists public.sk_missions (id uuid primary key default gen_random_uuid(), room uuid not null references public.sk_rooms(id) on delete cascade, creator uuid not null references auth.users(id), title text not null check(length(title) between 1 and 80), minutes integer not null check(minutes in(30,60,600)), done boolean not null default false, revision integer not null default 0, updated_at timestamptz not null default now());
create index if not exists sk_missions_room on public.sk_missions(room);
create table if not exists public.sk_claim_tickets (token uuid primary key default gen_random_uuid(), guest uuid not null references auth.users(id), target uuid references auth.users(id), expires_at timestamptz not null default now()+interval '20 minutes');
alter table public.sk_receipts enable row level security;
alter table public.sk_rooms enable row level security;
alter table public.sk_members enable row level security;
alter table public.sk_missions enable row level security;
alter table public.sk_claim_tickets enable row level security;
revoke all on public.sk_receipts,public.sk_rooms,public.sk_members,public.sk_missions,public.sk_claim_tickets from anon,authenticated;
grant select on public.sk_missions,public.sk_members to authenticated;
drop policy if exists own_membership on public.sk_members;
create policy own_membership on public.sk_members for select to authenticated using(member=auth.uid());
drop policy if exists room_missions on public.sk_missions;
create policy room_missions on public.sk_missions for select to authenticated using(exists(select 1 from public.sk_members m where m.room=sk_missions.room and m.member=auth.uid()));
create or replace function public.sk_validate_record(r jsonb) returns void language plpgsql set search_path='' as $$
begin
 if r is null or jsonb_typeof(r)<>'object' or octet_length(r::text)>30000 or length(coalesce(r->>'id','')) not between 1 and 120 or jsonb_typeof(r->'items') is distinct from 'array' then raise exception '영수증 형식을 확인해주세요.'; end if;
 if jsonb_array_length(r->'items') not between 1 and 60 then raise exception '술 항목 수를 확인해주세요.'; end if;
end $$;
create or replace function public.sk_save_receipt(p_record jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception '세션이 필요합니다.';end if;perform public.sk_validate_record(p_record);
 insert into public.sk_receipts(owner,id,record) values(auth.uid(),p_record->>'id',p_record) on conflict(owner,id) do update set record=excluded.record;
end $$;
create or replace function public.sk_history() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('receipts',coalesce((select jsonb_agg(x) from(select record,created_at from public.sk_receipts where owner=auth.uid() order by created_at desc limit 100)x),'[]'::jsonb),'rooms',coalesce((select jsonb_agg(x) from(select r.id,r.message,r.receipt->>'occasion' as occasion,r.purpose from public.sk_rooms r join public.sk_members m on m.room=r.id where m.member=auth.uid() order by r.created_at desc limit 100)x),'[]'::jsonb));
$$;
create or replace function public.sk_create_room(p_record jsonb,p_purpose text,p_message text,p_missions jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid; entry jsonb; reward int; title text;
begin
 if auth.uid() is null then raise exception '세션이 필요합니다.';end if;
 perform public.sk_validate_record(p_record);
 if p_purpose not in('result','mission') or p_message is null or length(p_message)>160 or jsonb_typeof(p_missions) is distinct from 'array' then raise exception '공유 내용을 확인해주세요.';end if;
 if (select count(distinct value) from jsonb_array_elements(p_missions))<>jsonb_array_length(p_missions) then raise exception '같은 미션은 한 번만 선택해주세요.';end if;
 if jsonb_array_length(p_missions)>18 then raise exception '미션 목록을 확인해주세요.';end if;
 if (select count(*) from public.sk_rooms where owner=auth.uid() and created_at>now()-interval '1 hour')>=30 then raise exception '잠시 후 다시 공유해주세요.';end if;
 insert into public.sk_rooms(owner,receipt,purpose,message) values(auth.uid(),p_record,p_purpose,p_message) returning id into rid;
 insert into public.sk_members values(rid,auth.uid());
 for entry in select * from jsonb_array_elements(p_missions) loop
 select t.n,t.v into title,reward from (values
 ('travel','함께 여행 가기',600),('concert','함께 콘서트 가기',600),('camping','함께 캠핑 가기',600),('meal','같이 밥 먹기',60),('movie','함께 영화 보기',60),('cooking','함께 요리하기',60),('picnic','함께 피크닉 가기',60),('exercise','함께 운동하기',60),('exhibition','함께 전시 보기',60),('walk','같이 산책하기',30),('tea','차 한 잔 마시기',30),('call','안부 묻고 통화하기',30),('game','함께 게임하기',30),('thanks','고마웠던 일 말하기',30),('photo','사진 보며 추억 나누기',30),('music','노래 추천하기',30),('plan','술 없는 만남 정하기',30),('laugh','재밌는 영상 공유하기',30)) as t(k,n,v) where t.k=entry#>>'{}';
 if title is null then raise exception '알 수 없는 미션입니다.';end if;
 insert into public.sk_missions(room,creator,title,minutes) values(rid,auth.uid(),title,reward);
 end loop;
 perform public.sk_save_receipt(p_record);return rid;
end $$;
create or replace function public.sk_read_room(p_id uuid) returns jsonb language sql security definer set search_path='' as $$select jsonb_build_object('id',id,'purpose',purpose,'message',message,'receipt',receipt,'social',true,'missions','[]'::jsonb) from public.sk_rooms where id=p_id$$;
create or replace function public.sk_join_room(p_id uuid) returns void language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null then raise exception '세션이 필요합니다.';end if;
 if not exists(select 1 from public.sk_rooms where id=p_id) then raise exception '공유 링크를 찾지 못했어요.';end if;
 insert into public.sk_members values(p_id,auth.uid()) on conflict do nothing;
end $$;
create or replace function public.sk_add_mission(p_room uuid,p_title text,p_id uuid) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.sk_members where room=p_room and member=auth.uid()) then raise exception '이 약속에 먼저 참여해주세요.';end if;
 perform 1 from public.sk_rooms where id=p_room for update;
 if exists(select 1 from public.sk_missions where id=p_id and room=p_room and creator=auth.uid()) then return;end if;
 if length(trim(p_title)) not between 1 and 80 then raise exception '미션은 1~80자로 입력해주세요.';end if;
 if (select count(*) from public.sk_missions where room=p_room)>=200 then raise exception '이 목록이 가득 찼어요.';end if;
 if exists(select 1 from public.sk_missions where room=p_room and title=trim(p_title)) then raise exception '이미 같은 이름의 미션이 있어요.';end if;
 insert into public.sk_missions(id,room,creator,title,minutes) values(p_id,p_room,auth.uid(),trim(p_title),30);
end $$;
create or replace function public.sk_check_mission(p_id uuid,p_done boolean,p_revision int) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.sk_missions x join public.sk_members m on m.room=x.room where x.id=p_id and m.member=auth.uid()) then raise exception '수정 권한이 없어요.';end if;
 update public.sk_missions set done=p_done,revision=revision+1,updated_at=now() where id=p_id and revision=p_revision;
 if not found then raise exception '친구가 먼저 변경했어요. 새 상태를 확인해주세요.';end if;
end $$;
create or replace function public.sk_prepare_claim() returns uuid language plpgsql security definer set search_path='' as $$declare t uuid;begin
 if auth.uid() is null or not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception '게스트 세션이 필요합니다.';end if;
 delete from public.sk_claim_tickets where guest=auth.uid() and target is null;
 insert into public.sk_claim_tickets(guest) values(auth.uid()) returning token into t;return t;
end $$;
create or replace function public.sk_claim(p_token uuid) returns void language plpgsql security definer set search_path='' as $$declare c public.sk_claim_tickets;begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception '계정 로그인이 필요합니다.';end if;
 select * into c from public.sk_claim_tickets where token=p_token for update;
 if not found then raise exception '기록 연결 정보를 찾지 못했어요.';end if;
 if c.target=auth.uid() then return;end if;
 if c.target is not null or c.expires_at<now() then raise exception '기록 연결 시간이 만료됐어요. 게스트 브라우저에서 다시 시도해주세요.';end if;
 insert into public.sk_receipts(owner,id,record,created_at) select auth.uid(),id,record,created_at from public.sk_receipts where owner=c.guest on conflict do nothing;
 insert into public.sk_members(room,member) select room,auth.uid() from public.sk_members where member=c.guest on conflict do nothing;
 update public.sk_rooms set owner=auth.uid() where owner=c.guest;
 update public.sk_missions set creator=auth.uid() where creator=c.guest;
 delete from public.sk_members where member=c.guest;
 delete from public.sk_receipts where owner=c.guest;
 update public.sk_claim_tickets set target=auth.uid() where token=p_token;
end $$;
-- RPC만 쓰기 허용. 누구의 계정인지 클라이언트가 지정할 수 없습니다.
revoke all on function public.sk_validate_record(jsonb) from public,anon,authenticated;
revoke all on function public.sk_save_receipt(jsonb),public.sk_history(),public.sk_create_room(jsonb,text,text,jsonb),public.sk_read_room(uuid),public.sk_join_room(uuid),public.sk_add_mission(uuid,text,uuid),public.sk_check_mission(uuid,boolean,int),public.sk_prepare_claim(),public.sk_claim(uuid) from public,anon,authenticated;
grant execute on function public.sk_read_room(uuid) to anon,authenticated;
grant execute on function public.sk_save_receipt(jsonb),public.sk_history(),public.sk_create_room(jsonb,text,text,jsonb),public.sk_join_room(uuid),public.sk_add_mission(uuid,text,uuid),public.sk_check_mission(uuid,boolean,int),public.sk_prepare_claim(),public.sk_claim(uuid) to authenticated;
do $$begin if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sk_missions') then alter publication supabase_realtime add table public.sk_missions;end if;end$$;
commit;
notify pgrst, 'reload schema';
