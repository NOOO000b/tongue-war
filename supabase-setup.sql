-- 舌戰：玩家資料表
-- 用法：在 Supabase 專案左邊選「SQL Editor」→「New query」，把這整個檔案貼上去，按「Run」。
-- 重複執行也沒關係，不會把已經有的資料清掉。

-- 每個玩家一筆資料（id 跟 Supabase 登入系統的帳號是同一個）
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text        not null default '青蛙',
  coins       integer     not null default 0,                -- 金幣（之後賺錢、買東西用）
  owned       jsonb       not null default '["frog"]',       -- 擁有的角色（一開始只有青蛙，其他到商店解鎖）
  equipped    jsonb       not null default '{"char":"frog"}', -- 目前選的角色
  games       integer     not null default 0,                -- 總場數
  wins        integer     not null default 0,                -- 勝場
  eats        integer     not null default 0,                -- 總共吃掉幾隻
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 安全規則：玩家的瀏覽器只能「看」自己的資料，不能自己改（金幣、戰績只有遊戲伺服器能改）
alter table public.profiles enable row level security;
drop policy if exists "玩家只能看自己的資料" on public.profiles;
create policy "玩家只能看自己的資料" on public.profiles for select using (auth.uid() = id);

-- 比賽結束時，伺服器用這個把戰績一次加上去
create or replace function public.add_match_stats(uid uuid, add_games int, add_wins int, add_eats int, add_coins int)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set games = games + add_games, wins = wins + add_wins, eats = eats + add_eats,
         coins = coins + add_coins, updated_at = now()
   where id = uid;
$$;
-- 只有伺服器（service_role 金鑰）可以呼叫，玩家不能自己幫自己加
revoke execute on function public.add_match_stats(uuid, int, int, int, int) from public, anon, authenticated;

-- 如果之前已經建過資料表：新玩家一開始只有青蛙
alter table public.profiles alter column owned set default '["frog"]';

-- 商店購買：檢查金幣夠不夠、是不是已經有了，然後一次扣錢、加進擁有清單
-- （鎖住這筆資料再改，同時按兩次也不會被扣兩次錢）
create or replace function public.buy_item(uid uuid, item text, price int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = uid for update;
  if not found then return jsonb_build_object('error', 'no_profile'); end if;
  if p.owned ? item then return jsonb_build_object('error', 'owned'); end if;
  if p.coins < price then return jsonb_build_object('error', 'coins'); end if;
  update public.profiles set coins = coins - price, owned = owned || to_jsonb(item), updated_at = now()
   where id = uid returning * into p;
  return jsonb_build_object('coins', p.coins, 'owned', p.owned);
end $$;
revoke execute on function public.buy_item(uuid, text, int) from public, anon, authenticated;

-- 成就：累積的數據（逃脫、救援、一場最多吃幾隻、贏過的地圖和模式、每隻角色贏幾場…）和已經領過的成就
alter table public.profiles add column if not exists stats   jsonb not null default '{}';
alter table public.profiles add column if not exists claimed jsonb not null default '[]';

-- 領成就獎勵：確認沒領過，然後一次記下來、加金幣（同時按兩次也只會領到一次）
create or replace function public.claim_achievement(uid uuid, akey text, reward int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = uid for update;
  if not found then return jsonb_build_object('error', 'no_profile'); end if;
  if p.claimed ? akey then return jsonb_build_object('error', 'claimed'); end if;
  update public.profiles set coins = coins + reward, claimed = claimed || to_jsonb(akey), updated_at = now()
   where id = uid returning * into p;
  return jsonb_build_object('coins', p.coins);
end $$;
revoke execute on function public.claim_achievement(uuid, text, int) from public, anon, authenticated;
