-- Module 12: Thesis-specific roles; drop the general/thesis document_type
--
-- This app is being scoped down to a single-purpose thesis approval
-- workflow. The generic submitter/approver/admin roles are replaced with
-- the actual thesis participants (student, advisor, committee_member,
-- department_chair, graduate_school, registrar). Since every document is
-- now a thesis and every reviewer's function is named by their role, both
-- the document_type toggle and the profiles.title label added in 0011
-- become redundant and are dropped here.
--
-- Enum value changes aren't a straight rename (approver fans out into four
-- new values), so a new type is created, the column is migrated onto it via
-- a CASE mapping, and the old type is dropped. Any function typed on the
-- old enum has to be dropped and recreated to bind to the new type.

-- =========================================================
-- 1. ENUM SWAP: user_role
-- =========================================================

create type public.user_role_new as enum (
  'student',
  'advisor',
  'committee_member',
  'department_chair',
  'graduate_school',
  'registrar'
);

-- Both typed on the old enum; must go before the old type can be dropped.
-- Recreated further down against the new type. current_user_role() is
-- referenced directly in six SELECT policies' USING clauses (RLS policy
-- expressions are dependency-tracked, unlike plpgsql function bodies), so
-- dropping it requires cascade -- all six are recreated in section 5 below.
drop function if exists public.current_user_role() cascade;
drop function if exists public.promote_user_role(uuid, public.user_role);

-- profiles_select_approvers references the role column directly in its
-- USING clause (unlike current_user_role() above, ALTER COLUMN TYPE has no
-- CASCADE option, so this has to be dropped explicitly) -- recreated in
-- section 5 below.
drop policy if exists "profiles_select_approvers" on public.profiles;

alter table public.profiles alter column role drop default;
alter table public.profiles
  alter column role type public.user_role_new
  using (
    case role::text
      when 'submitter' then 'student'
      when 'approver' then 'advisor'
      when 'admin' then 'registrar'
      else 'student'
    end
  )::public.user_role_new;
alter table public.profiles alter column role set default 'student';

drop type public.user_role;
alter type public.user_role_new rename to user_role;

-- =========================================================
-- 2. RECREATE FUNCTIONS TYPED ON user_role
-- =========================================================

create function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.promote_user_role(p_user_id uuid, p_new_role public.user_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_role public.user_role;
begin
  if public.current_user_role() <> 'registrar' then
    raise exception 'only the registrar can change user roles';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'the registrar cannot change their own role';
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

-- =========================================================
-- 3. DROP document_type (0011) AND profiles.title (0011)
-- =========================================================

drop function if exists public.submit_document(text, text, uuid[], uuid, public.document_type);

alter table public.documents drop column if exists document_type;
drop type if exists public.document_type;

alter table public.profiles drop column if exists title;

-- =========================================================
-- 4. RECREATE submit_document WITHOUT document_type, NEW ROLE CHECK
-- =========================================================

create or replace function public.submit_document(
  p_title text,
  p_file_path text,
  p_approver_ids uuid[],
  p_resubmitted_from uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document_id uuid;
  v_approver_id uuid;
  v_step_order int := 0;
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;

  if p_approver_ids is null or array_length(p_approver_ids, 1) is null then
    raise exception 'at least one approver is required';
  end if;

  if exists (
    select 1 from unnest(p_approver_ids) as aid
    where not exists (
      select 1 from public.profiles pr
      where pr.id = aid
        and pr.role in ('advisor', 'committee_member', 'department_chair', 'graduate_school', 'registrar')
    )
  ) then
    raise exception 'all approvers must hold a thesis-reviewing role';
  end if;

  if p_resubmitted_from is not null and not exists (
    select 1 from public.documents d
    where d.id = p_resubmitted_from and d.submitter_id = auth.uid() and d.status = 'rejected'
  ) then
    raise exception 'resubmitted_from must reference one of your own rejected documents';
  end if;

  insert into public.documents (title, file_path, submitter_id, resubmitted_from)
  values (p_title, p_file_path, auth.uid(), p_resubmitted_from)
  returning id into v_document_id;

  foreach v_approver_id in array p_approver_ids loop
    v_step_order := v_step_order + 1;
    insert into public.approval_steps (document_id, step_order, approver_id, status)
    values (
      v_document_id,
      v_step_order,
      v_approver_id,
      case when v_step_order = 1 then 'pending' else 'waiting' end
    );
  end loop;

  perform public.insert_audit_log(
    'document_submitted',
    auth.uid(),
    v_document_id,
    null,
    jsonb_build_object(
      'title', p_title,
      'approver_count', array_length(p_approver_ids, 1),
      'resubmitted_from', p_resubmitted_from
    )
  );

  return v_document_id;
end;
$$;

grant execute on function public.submit_document(text, text, uuid[], uuid) to authenticated;

-- =========================================================
-- 5. RECREATE RLS POLICIES REFERENCING OLD ROLE LITERALS
-- =========================================================

drop policy if exists "profiles_select_approvers" on public.profiles;
create policy "profiles_select_approvers"
  on public.profiles for select
  using (role in ('advisor', 'committee_member', 'department_chair', 'graduate_school', 'registrar'));

drop policy if exists "profiles_select_admin_all" on public.profiles;
create policy "profiles_select_admin_all"
  on public.profiles for select
  using (public.current_user_role() = 'registrar');

drop policy if exists "documents_select" on public.documents;
create policy "documents_select"
  on public.documents for select
  using (
    submitter_id = auth.uid()
    or exists (
      select 1 from public.approval_steps s
      where s.document_id = documents.id and s.approver_id = auth.uid()
    )
    or public.current_user_role() = 'registrar'
  );

drop policy if exists "approval_steps_select" on public.approval_steps;
create policy "approval_steps_select"
  on public.approval_steps for select
  using (
    approver_id = auth.uid()
    or exists (
      select 1 from public.documents d
      where d.id = approval_steps.document_id and d.submitter_id = auth.uid()
    )
    or public.current_user_role() = 'registrar'
  );

drop policy if exists "documents_storage_select" on storage.objects;
create policy "documents_storage_select"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.documents d
        join public.approval_steps s on s.document_id = d.id
        where d.file_path = name and s.approver_id = auth.uid()
      )
      or public.current_user_role() = 'registrar'
    )
  );

drop policy if exists "signatures_select" on public.signatures;
create policy "signatures_select"
  on public.signatures for select
  using (
    exists (
      select 1 from public.documents d
      where d.id = signatures.document_id
        and (
          d.submitter_id = auth.uid()
          or exists (
            select 1 from public.approval_steps s
            where s.document_id = d.id and s.approver_id = auth.uid()
          )
          or public.current_user_role() = 'registrar'
        )
    )
  );

drop policy if exists "audit_log_select" on public.audit_log;
create policy "audit_log_select"
  on public.audit_log for select
  using (
    public.current_user_role() = 'registrar'
    or actor_id = auth.uid()
    or (
      document_id is not null
      and exists (
        select 1 from public.documents d
        where d.id = audit_log.document_id
          and (
            d.submitter_id = auth.uid()
            or exists (
              select 1 from public.approval_steps s
              where s.document_id = d.id and s.approver_id = auth.uid()
            )
          )
      )
    )
  );

create or replace function public.verify_audit_chain()
returns table (broken_seq bigint, reason text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.current_user_role() <> 'registrar' then
    raise exception 'only the registrar can verify the audit chain';
  end if;

  return query
  with ordered as (
    select
      a.seq, a.event_type, a.actor_id, a.document_id, a.approval_step_id,
      a.metadata, a.created_at, a.prev_hash, a.entry_hash,
      lag(a.entry_hash) over (order by a.seq) as actual_prev_entry_hash
    from public.audit_log a
  )
  select
    o.seq,
    case
      when coalesce(o.prev_hash, 'GENESIS') is distinct from coalesce(o.actual_prev_entry_hash, 'GENESIS')
        then 'prev_hash does not match the preceding entry'
      when o.entry_hash <> encode(
        digest(
          coalesce(o.prev_hash, 'GENESIS') || '|' ||
          o.seq::text || '|' || o.event_type || '|' ||
          coalesce(o.actor_id::text, '') || '|' ||
          coalesce(o.document_id::text, '') || '|' ||
          coalesce(o.approval_step_id::text, '') || '|' ||
          coalesce(o.metadata::text, '{}') || '|' ||
          o.created_at::text,
          'sha256'
        ),
        'hex'
      ) then 'entry_hash does not match the recomputed hash'
      else null
    end as reason
  from ordered o
  where (
    coalesce(o.prev_hash, 'GENESIS') is distinct from coalesce(o.actual_prev_entry_hash, 'GENESIS')
    or o.entry_hash <> encode(
      digest(
        coalesce(o.prev_hash, 'GENESIS') || '|' ||
        o.seq::text || '|' || o.event_type || '|' ||
        coalesce(o.actor_id::text, '') || '|' ||
        coalesce(o.document_id::text, '') || '|' ||
        coalesce(o.approval_step_id::text, '') || '|' ||
        coalesce(o.metadata::text, '{}') || '|' ||
        o.created_at::text,
        'sha256'
      ),
      'hex'
    )
  )
  order by o.seq;
end;
$$;

grant execute on function public.verify_audit_chain() to authenticated;

-- =========================================================
-- 6. UPDATE SELF-REGISTRATION ALLOW-LIST (handle_new_user)
-- =========================================================

create or replace function public.handle_new_user()
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
      when new.raw_user_meta_data ->> 'requested_role' in
        ('student', 'advisor', 'committee_member', 'department_chair', 'graduate_school')
        then (new.raw_user_meta_data ->> 'requested_role')::public.user_role
      else 'student'::public.user_role
    end
  );

  return new;
end;
$$;
