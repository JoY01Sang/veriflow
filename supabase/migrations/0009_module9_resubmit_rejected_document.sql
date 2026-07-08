-- Module 9: Allow resubmitting a rejected document
--
-- Rejection was previously a dead end: act_on_approval_step marks the
-- document 'rejected' and there was no path back in. Resubmission is
-- modeled as a brand new document (new id, new approval_steps, fresh
-- signatures) rather than resetting the rejected one in place -- the
-- rejected document and its audit trail must stay exactly as they were
-- for the record. resubmitted_from links the new document back to the
-- one it replaces, for traceability only.

alter table public.documents
  add column if not exists resubmitted_from uuid references public.documents (id);

-- The 3-arg overload from 0006 must go: leaving it in place alongside the new
-- 4-arg version (with a default) makes any 3-arg call ambiguous between them.
drop function if exists public.submit_document(text, text, uuid[]);

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
