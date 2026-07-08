-- Module 5: Atomic document submission
--
-- The client used to insert into documents and then approval_steps as two
-- separate requests. If the second insert failed (network error, RLS
-- mismatch, etc.) the document row was left behind with no steps at all --
-- "pending" forever, since act_on_approval_step has nothing to act on and
-- no step is ever waiting/pending. Doing both inserts inside one
-- SECURITY DEFINER function makes them transactional: either the document
-- and its whole approval chain are created together, or neither is.

create or replace function public.submit_document(p_title text, p_file_path text, p_approver_ids uuid[])
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

  insert into public.documents (title, file_path, submitter_id)
  values (p_title, p_file_path, auth.uid())
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

  return v_document_id;
end;
$$;

grant execute on function public.submit_document(text, text, uuid[]) to authenticated;
