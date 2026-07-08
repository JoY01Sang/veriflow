
-- =========================================================
-- 0. EXTENSIONS
-- =========================================================

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- =========================================================
-- 1. ROLE TYPE (STRICT CONTROLLED VALUES)
-- =========================================================

drop type if exists public.user_role cascade;

create type public.user_role as enum (
  'submitter',
  'approver',
  'admin'
);

-- NOTE:
-- The app and later RLS policies reference an admin role. Admin users
-- should still be promoted deliberately by a database/service-role operator,
-- not through public self-registration.

-- =========================================================
-- 2. PROFILES TABLE
-- =========================================================

drop table if exists public.profiles cascade;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text unique,
  role public.user_role not null default 'submitter',
  created_at timestamptz default now()
);

-- =========================================================
-- 3. ENABLE RLS
-- =========================================================

alter table public.profiles enable row level security;

-- =========================================================
-- 4. RLS POLICIES
-- =========================================================

-- SELECT: Users can read their own profile
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- UPDATE: Users can update their own profile
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- SELECT: All users can read approvers/admins for approval chain selection
drop policy if exists "profiles_select_approvers" on public.profiles;
create policy "profiles_select_approvers"
  on public.profiles for select
  using (role in ('approver', 'admin'));

-- DENY INSERT/DELETE from clients (only trigger can insert)
drop policy if exists "deny_all_insert" on public.profiles;
create policy "deny_all_insert"
  on public.profiles for insert
  with check (false);

-- =========================================================
-- 5. AUTO PROFILE CREATION FUNCTION
-- =========================================================

drop function if exists public.handle_new_user() cascade;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email,
    case
      when new.raw_user_meta_data ->> 'requested_role' in ('submitter', 'approver')
        then (new.raw_user_meta_data ->> 'requested_role')::public.user_role
      else 'submitter'::public.user_role
    end
  );

  return new;
end;
$$;

-- =========================================================
-- 6. TRIGGER
-- =========================================================

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_user();

-- =========================================================
-- 7. HELPER FUNCTION (ROLE CHECK)
-- =========================================================

drop function if exists public.current_user_role;

create function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- =========================================================
-- END
-- =========================================================