-- Module 14 (fix): submit_document() failed on every real submission with
-- "column status is of type approval_step_status but expression is of type
-- text". A `case when ... then 'pending' else 'waiting' end` expression
-- resolves to text (unlike a bare string literal, which stays untyped and
-- auto-coerces to the target column's type), so Postgres refused to insert
-- it into the approval_step_status enum column. This bug has been present
-- in every version of submit_document since 0005 -- it just hadn't been
-- exercised against a real submission until now. Fix: cast explicitly.

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
      (case when v_step_order = 1 then 'pending' else 'waiting' end)::public.approval_step_status
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
