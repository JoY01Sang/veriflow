-- Module 13: Registrar-assigned, fixed thesis committees
--
-- Replaces per-submission manual approver picking with a fixed chain the
-- registrar assigns once per student: Advisor -> Committee Member 1 ->
-- Committee Member 2 -> Department Chair -> Graduate School. Every future
-- submission (including resubmissions) reads this assignment automatically
-- instead of asking the student to pick reviewers.

-- =========================================================
-- 1. ASSIGNMENT COLUMNS
-- =========================================================

alter table public.profiles
  add column if not exists advisor_id uuid references public.profiles (id),
  add column if not exists committee_member_1_id uuid references public.profiles (id),
  add column if not exists committee_member_2_id uuid references public.profiles (id),
  add column if not exists department_chair_id uuid references public.profiles (id),
  add column if not exists graduate_school_id uuid references public.profiles (id);

-- =========================================================
-- 2. LOCK THE COLUMNS: only assign_thesis_committee() may change them
-- =========================================================
--
-- profiles_update_own (0001) lets a user update any column on their own
-- row, including these -- without this trigger a student could set their
-- own advisor_id directly. Mirrors protect_profile_role() (0007).

create or replace function public.protect_thesis_committee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.advisor_id is distinct from old.advisor_id
    or new.committee_member_1_id is distinct from old.committee_member_1_id
    or new.committee_member_2_id is distinct from old.committee_member_2_id
    or new.department_chair_id is distinct from old.department_chair_id
    or new.graduate_school_id is distinct from old.graduate_school_id
  )
  and coalesce(current_setting('app.bypass_committee_lock', true), 'false') <> 'true' then
    raise exception 'committee assignment cannot be changed directly; use assign_thesis_committee';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_thesis_committee on public.profiles;
create trigger protect_thesis_committee
  before update on public.profiles
  for each row execute function public.protect_thesis_committee();

-- =========================================================
-- 3. ASSIGNMENT RPC (registrar-only)
-- =========================================================

create or replace function public.assign_thesis_committee(
  p_student_id uuid,
  p_advisor_id uuid,
  p_committee_member_1_id uuid,
  p_committee_member_2_id uuid,
  p_department_chair_id uuid,
  p_graduate_school_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_role public.user_role;
begin
  if public.current_user_role() <> 'registrar' then
    raise exception 'only the registrar can assign a thesis committee';
  end if;

  select role into v_student_role from public.profiles where id = p_student_id;

  if v_student_role is null then
    raise exception 'student not found';
  end if;

  if v_student_role <> 'student' then
    raise exception 'committee assignments can only be made for students';
  end if;

  if p_advisor_id is not null and not exists (
    select 1 from public.profiles where id = p_advisor_id and role = 'advisor'
  ) then
    raise exception 'p_advisor_id must reference a profile with the advisor role';
  end if;

  if p_committee_member_1_id is not null and not exists (
    select 1 from public.profiles where id = p_committee_member_1_id and role = 'committee_member'
  ) then
    raise exception 'p_committee_member_1_id must reference a profile with the committee_member role';
  end if;

  if p_committee_member_2_id is not null and not exists (
    select 1 from public.profiles where id = p_committee_member_2_id and role = 'committee_member'
  ) then
    raise exception 'p_committee_member_2_id must reference a profile with the committee_member role';
  end if;

  if p_department_chair_id is not null and not exists (
    select 1 from public.profiles where id = p_department_chair_id and role = 'department_chair'
  ) then
    raise exception 'p_department_chair_id must reference a profile with the department_chair role';
  end if;

  if p_graduate_school_id is not null and not exists (
    select 1 from public.profiles where id = p_graduate_school_id and role = 'graduate_school'
  ) then
    raise exception 'p_graduate_school_id must reference a profile with the graduate_school role';
  end if;

  perform set_config('app.bypass_committee_lock', 'true', true);

  update public.profiles
  set
    advisor_id = p_advisor_id,
    committee_member_1_id = p_committee_member_1_id,
    committee_member_2_id = p_committee_member_2_id,
    department_chair_id = p_department_chair_id,
    graduate_school_id = p_graduate_school_id
  where id = p_student_id;

  perform public.insert_audit_log(
    'thesis_committee_assigned',
    auth.uid(),
    null,
    null,
    jsonb_build_object(
      'student_id', p_student_id,
      'advisor_id', p_advisor_id,
      'committee_member_1_id', p_committee_member_1_id,
      'committee_member_2_id', p_committee_member_2_id,
      'department_chair_id', p_department_chair_id,
      'graduate_school_id', p_graduate_school_id
    )
  );
end;
$$;

grant execute on function public.assign_thesis_committee(uuid, uuid, uuid, uuid, uuid, uuid) to authenticated;

-- =========================================================
-- 4. REWRITE submit_document: fixed chain, no p_approver_ids
-- =========================================================

drop function if exists public.submit_document(text, text, uuid[], uuid);

create or replace function public.submit_document(
  p_title text,
  p_file_path text,
  p_resubmitted_from uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document_id uuid;
  v_chain uuid[];
  v_approver_id uuid;
  v_step_order int := 0;
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;

  select array[advisor_id, committee_member_1_id, committee_member_2_id, department_chair_id, graduate_school_id]
    into v_chain
    from public.profiles
    where id = auth.uid();

  if v_chain is null or array_position(v_chain, null) is not null then
    raise exception 'your thesis committee has not been fully assigned yet — contact the registrar';
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

  foreach v_approver_id in array v_chain loop
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
      'approver_count', array_length(v_chain, 1),
      'resubmitted_from', p_resubmitted_from
    )
  );

  return v_document_id;
end;
$$;

grant execute on function public.submit_document(text, text, uuid) to authenticated;
