-- Module 15 (fix): "infinite recursion detected in policy for relation
-- approval_steps" (42P17).
--
-- documents_select contains a subquery into approval_steps, and
-- approval_steps_select contains a subquery into documents. Evaluating
-- either policy requires evaluating the other table's RLS, which requires
-- evaluating the first table's RLS again -- an unbreakable cycle. This has
-- been latent since 0002; it only surfaced once there were real rows in
-- both tables to query (via 0014's fix letting submissions actually
-- succeed).
--
-- Fix: SECURITY DEFINER helper functions, same trick current_user_role()
-- already uses to read profiles.role without recursing into profiles' own
-- RLS. A function owned by a role that bypasses RLS (the default for
-- SECURITY DEFINER functions here) queries the other table without
-- re-triggering its SELECT policy, breaking the cycle.

create or replace function public.is_submitter_of_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.documents d
    where d.id = p_document_id and d.submitter_id = auth.uid()
  );
$$;

create or replace function public.is_approver_on_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.approval_steps s
    where s.document_id = p_document_id and s.approver_id = auth.uid()
  );
$$;

drop policy if exists "documents_select" on public.documents;
create policy "documents_select"
  on public.documents for select
  using (
    submitter_id = auth.uid()
    or public.is_approver_on_document(documents.id)
    or public.current_user_role() = 'registrar'
  );

drop policy if exists "approval_steps_select" on public.approval_steps;
create policy "approval_steps_select"
  on public.approval_steps for select
  using (
    approver_id = auth.uid()
    or public.is_submitter_of_document(approval_steps.document_id)
    or public.current_user_role() = 'registrar'
  );

-- signatures_select and audit_log_select each independently nested a
-- documents-containing-approval_steps subquery, which fed into the same
-- cycle -- rewritten to use the helper functions too, both to fix that and
-- to stop duplicating the submitter-or-approver check inline.

drop policy if exists "signatures_select" on public.signatures;
create policy "signatures_select"
  on public.signatures for select
  using (
    public.is_submitter_of_document(signatures.document_id)
    or public.is_approver_on_document(signatures.document_id)
    or public.current_user_role() = 'registrar'
  );

drop policy if exists "audit_log_select" on public.audit_log;
create policy "audit_log_select"
  on public.audit_log for select
  using (
    public.current_user_role() = 'registrar'
    or actor_id = auth.uid()
    or (
      document_id is not null
      and (
        public.is_submitter_of_document(audit_log.document_id)
        or public.is_approver_on_document(audit_log.document_id)
      )
    )
  );

-- documents_storage_select queries documents+approval_steps by storage path
-- rather than by document id, so it isn't part of the direct cycle, but it
-- still benefits from the same helper for consistency.
drop policy if exists "documents_storage_select" on storage.objects;
create policy "documents_storage_select"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.documents d
        where d.file_path = name and public.is_approver_on_document(d.id)
      )
      or public.current_user_role() = 'registrar'
    )
  );
