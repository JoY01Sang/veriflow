-- Module 7: Admin user management
--
-- The admin role is intentionally not self-assignable (see 0001) -- the very
-- first admin must still be promoted by a database/service-role operator:
--
--   update public.profiles set role = 'admin' where email = 'someone@example.com';
--
-- This migration lets an *existing* admin promote/demote other users'
-- roles from within the app, instead of every change requiring direct SQL.

-- Admins need to see every profile (not just approvers/admins) to manage roles.
drop policy if exists "profiles_select_admin_all" on public.profiles;
create policy "profiles_select_admin_all"
  on public.profiles for select
  using (public.current_user_role() = 'admin');

-- profiles_update_own (0001) lets a user update any column on their own row,
-- including role -- so any authenticated client could currently do
-- `update profiles set role = 'admin' where id = auth.uid()` and RLS would
-- allow it, since that policy only checks row ownership, not which columns
-- changed. This trigger closes that hole: role can only change via
-- promote_user_role below, which is gated to admins acting on other users.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and coalesce(current_setting('app.bypass_role_lock', true), 'false') <> 'true' then
    raise exception 'role cannot be changed directly; use promote_user_role';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

create or replace function public.promote_user_role(p_user_id uuid, p_new_role public.user_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_role public.user_role;
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'only admins can change user roles';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'admins cannot change their own role';
  end if;

  select role into v_previous_role from public.profiles where id = p_user_id;

  if v_previous_role is null then
    raise exception 'user not found';
  end if;

  perform set_config('app.bypass_role_lock', 'true', true);

  update public.profiles set role = p_new_role where id = p_user_id;

  perform public.insert_audit_log(
    'user_role_changed',
    auth.uid(),
    null,
    null,
    jsonb_build_object('target_user_id', p_user_id, 'previous_role', v_previous_role, 'new_role', p_new_role)
  );
end;
$$;

grant execute on function public.promote_user_role(uuid, public.user_role) to authenticated;
