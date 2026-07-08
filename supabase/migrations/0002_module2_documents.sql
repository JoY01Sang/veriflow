-- Module 2: Document Submission and Workflow Routing

drop type if exists public.document_status cascade;
create type public.document_status as enum ('pending', 'approved', 'rejected');
drop type if exists public.approval_step_status cascade;
create type public.approval_step_status as enum ('waiting', 'pending', 'approved', 'rejected', 'skipped');

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  file_path text not null,
  submitter_id uuid not null references public.profiles (id),
  status public.document_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.approval_steps (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  step_order int not null,
  approver_id uuid not null references public.profiles (id),
  status public.approval_step_status not null default 'waiting',
  comment text,
  acted_at timestamptz,
  unique (document_id, step_order)
);

alter table public.documents enable row level security;
alter table public.approval_steps enable row level security;

-- Any authenticated user can see who the approvers/admins are, so a
-- submitter can build an approval chain. Their own profile is already
-- visible via profiles_select_own from Module 1.
drop policy if exists "profiles_select_approvers" on public.profiles;
create policy "profiles_select_approvers"
  on public.profiles for select
  using (role in ('approver', 'admin'));

-- Documents: visible to their submitter, any approver assigned a step on
-- them, or an admin.
drop policy if exists "documents_select" on public.documents;
create policy "documents_select"
  on public.documents for select
  using (
    submitter_id = auth.uid()
    or exists (
      select 1 from public.approval_steps s
      where s.document_id = documents.id and s.approver_id = auth.uid()
    )
    or public.current_user_role() = 'admin'
  );

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own"
  on public.documents for insert
  with check (submitter_id = auth.uid());

-- No update policy: status transitions only happen through act_on_approval_step,
-- which runs as the function owner and bypasses RLS after checking authorization itself.

-- Approval steps: visible to the assigned approver, the document's submitter,
-- or an admin.
drop policy if exists "approval_steps_select" on public.approval_steps;
create policy "approval_steps_select"
  on public.approval_steps for select
  using (
    approver_id = auth.uid()
    or exists (
      select 1 from public.documents d
      where d.id = approval_steps.document_id and d.submitter_id = auth.uid()
    )
    or public.current_user_role() = 'admin'
  );

-- Only the submitter of the parent document can create its steps (done once,
-- right after creating the document, as part of submission).
drop policy if exists "approval_steps_insert_by_submitter" on public.approval_steps;
create policy "approval_steps_insert_by_submitter"
  on public.approval_steps for insert
  with check (
    exists (
      select 1 from public.documents d
      where d.id = approval_steps.document_id and d.submitter_id = auth.uid()
    )
  );

-- Storage: each user uploads into a folder named after their own uid;
-- the submitter, any assigned approver, or an admin can read the file back.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents_storage_insert_own_folder" on storage.objects;
create policy "documents_storage_insert_own_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
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
      or public.current_user_role() = 'admin'
    )
  );

-- Approve or reject the calling user's current step on a document. Runs as
-- the function owner so it can advance the next step / finalize the document
-- status atomically; authorization is enforced explicitly inside instead of
-- relying on row-level RLS, since this touches rows the caller doesn't own.
create or replace function public.act_on_approval_step(p_step_id uuid, p_decision text, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step public.approval_steps;
  v_next_order int;
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

  update public.approval_steps
  set status = p_decision::public.approval_step_status, comment = p_comment, acted_at = now()
  where id = p_step_id;

  if p_decision = 'rejected' then
    update public.documents set status = 'rejected' where id = v_step.document_id;
    update public.approval_steps
      set status = 'skipped'
      where document_id = v_step.document_id and status = 'waiting';
  else
    select min(step_order) into v_next_order
      from public.approval_steps
      where document_id = v_step.document_id and step_order > v_step.step_order;

    if v_next_order is null then
      update public.documents set status = 'approved' where id = v_step.document_id;
    else
      update public.approval_steps
        set status = 'pending'
        where document_id = v_step.document_id and step_order = v_next_order;
    end if;
  end if;
end;
$$;

grant execute on function public.act_on_approval_step(uuid, text, text) to authenticated;

-- Live status updates for submitters/approvers.
alter publication supabase_realtime add table public.documents;
alter publication supabase_realtime add table public.approval_steps;
