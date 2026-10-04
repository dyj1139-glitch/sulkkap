-- Supabase SQL Editor에서 전체를 붙여넣고 Run을 누르세요.
-- 기존 테이블과 영수증은 유지합니다. 여러 번 실행해도 됩니다.
begin;
create or replace function public.create_sulkkap_share(
  p_receipt jsonb,
  p_purpose text default 'result',
  p_missions jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then
    raise exception '영수증 데이터가 올바르지 않습니다.';
  end if;
  if octet_length(p_receipt::text) > 30000 then
    raise exception '영수증 데이터가 너무 큽니다.';
  end if;
  if p_purpose is null or p_purpose not in ('result', 'mission') then
    raise exception '공유 종류가 올바르지 않습니다.';
  end if;
  if p_missions is null or jsonb_typeof(p_missions) <> 'array' then
    raise exception '미션 목록이 올바르지 않습니다.';
  end if;
  if jsonb_array_length(p_missions) > 3 then
    raise exception '미션은 최대 3개까지 선택할 수 있습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_missions) as m(value)
    where m.value not in (
      '"meal"'::jsonb, '"walk"'::jsonb, '"thanks"'::jsonb,
      '"tea"'::jsonb, '"call"'::jsonb, '"photo"'::jsonb,
      '"music"'::jsonb, '"game"'::jsonb, '"plan"'::jsonb,
      '"laugh"'::jsonb
    )
  ) then
    raise exception '지원하지 않는 미션입니다.';
  end if;
  if (select count(distinct m.value) from jsonb_array_elements(p_missions) as m(value))
     <> jsonb_array_length(p_missions) then
    raise exception '같은 미션을 중복 선택할 수 없습니다.';
  end if;
  if p_purpose = 'result' and jsonb_array_length(p_missions) <> 0 then
    raise exception '결과 공유에는 미션을 넣을 수 없습니다.';
  end if;
  if p_purpose = 'mission' and jsonb_array_length(p_missions) = 0 then
    raise exception '미션을 하나 이상 선택해주세요.';
  end if;
  insert into public.sulkkap_shares (purpose, receipt, missions)
  values (p_purpose, p_receipt, p_missions)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_sulkkap_share(jsonb, text, jsonb)
from public, anon, authenticated;
grant execute on function public.create_sulkkap_share(jsonb, text, jsonb)
to anon, authenticated;
commit;
