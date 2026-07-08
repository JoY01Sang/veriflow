-- Module 11: University thesis approval workflow
--
-- Adds a document_type so a submission can be flagged as a 'thesis' (vs a
-- generic document), and a free-text 'title' on profiles so faculty can
-- label their role in an approval chain (e.g. "Thesis Advisor", "Committee
-- Member", "Department Chair", "Graduate School"). Both are purely additive:
-- the existing user_role enum, RLS policies, and act_on_approval_step are
-- untouched, since neither field carries any permission meaning.

create type public.document_type as enum ('general', 'thesis');

alter table public.documents
  add column if not exists document_type public.document_type not null default 'general';

alter table public.profiles
  add column if not exists title text;

-- The 4-arg overload from 0009 must go: leaving it in place alongside the
-- new 5-arg version (with a default) makes any 4-arg call ambiguous.
drop function if exists public.submit_document(text, text, uuid[], uuid);

create or replace function public.submit_document(
  p_title text,
  p_file_path text,
  p_approver_ids uuid[],
  p_resubmitted_from uuid default null,
  p_document_type public.document_type default 'general'
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
      select 1 from public.profiles pr where pr.id = aid and pr.role in ('approver', 'admin')
    )
  ) then
    raise exception 'all approvers must have the approver or admin role';
  end if;

  if p_resubmitted_from is not null and not exists (
    select 1 from public.documents d
    where d.id = p_resubmitted_from and d.submitter_id = auth.uid() and d.status = 'rejected'
  ) then
    raise exception 'resubmitted_from must reference one of your own rejected documents';
  end if;

  insert into public.documents (title, file_path, submitter_id, resubmitted_from, document_type)
  values (p_title, p_file_path, auth.uid(), p_resubmitted_from, p_document_type)
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
      'resubmitted_from', p_resubmitted_from,
      'document_type', p_document_type
    )
  );

  return v_document_id;
end;
$$;

grant execute on function public.submit_document(text, text, uuid[], uuid, public.document_type) to authenticated;
