-- Module 6: Add audit logging to key workflows
-- This migration updates the submit_document and act_on_approval_step functions
-- to log audit events when documents are submitted and approved/rejected.

-- Update submit_document to log "document_submitted" event
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

  perform public.insert_audit_log(
    'document_submitted',
    auth.uid(),
    v_document_id,
    null,
    jsonb_build_object('title', p_title, 'approver_count', array_length(p_approver_ids, 1))
  );

  return v_document_id;
end;
$$;

grant execute on function public.submit_document(text, text, uuid[]) to authenticated;

-- Update act_on_approval_step to log "approval_step_approved" and "approval_step_rejected" events
create or replace function public.act_on_approval_step(p_step_id uuid, p_decision text, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step public.approval_steps;
  v_next_order int;
  v_document_id uuid;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision: %', p_decision;
  end if;

  select * into v_step from public.approval_steps where id = p_step_id for update;

  if v_step is null then
    raise exception 'approval step not found';
  end if;

  if v_step.approver_id <> auth.uid() then
    raise exception 'not authorized to act on this step';
  end if;

  if v_step.status <> 'pending' then
    raise exception 'this step is not currently actionable';
  end if;

  v_document_id := v_step.document_id;

  update public.approval_steps
  set status = p_decision::public.approval_step_status, comment = p_comment, acted_at = now()
  where id = p_step_id;

  if p_decision = 'rejected' then
    update public.documents set status = 'rejected' where id = v_document_id;
    update public.approval_steps
      set status = 'skipped'
      where document_id = v_document_id and status = 'waiting';

    perform public.insert_audit_log(
      'approval_step_rejected',
      auth.uid(),
      v_document_id,
      p_step_id,
      jsonb_build_object('step_order', v_step.step_order, 'comment', p_comment)
    );
  else
    select min(step_order) into v_next_order
      from public.approval_steps
      where document_id = v_document_id and step_order > v_step.step_order;

    if v_next_order is null then
      update public.documents set status = 'approved' where id = v_document_id;

      perform public.insert_audit_log(
        'document_approved',
        auth.uid(),
        v_document_id,
        p_step_id,
        jsonb_build_object('final_step', v_step.step_order, 'comment', p_comment)
      );
    else
      update public.approval_steps
        set status = 'pending'
        where document_id = v_document_id and step_order = v_next_order;

      perform public.insert_audit_log(
        'approval_step_approved',
        auth.uid(),
        v_document_id,
        p_step_id,
        jsonb_build_object('step_order', v_step.step_order, 'next_step', v_next_order, 'comment', p_comment)
      );
    end if;
  end if;
end;
$$;

grant execute on function public.act_on_approval_step(uuid, text, text) to authenticated;
