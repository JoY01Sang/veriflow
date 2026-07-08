-- Module 16: Cosmetic signature certificate stamped into a copy of the PDF
--
-- sign-approval-step now generates a certificate copy of the document with
-- an appended page listing signers so far, for anyone who downloads/prints
-- it. This is a VISUAL record only -- it does not affect the real
-- cryptographic verification, which continues to run exclusively against
-- documents.file_path (the untouched original the signatures were actually
-- computed against). certified_file_path is a separate, independently
-- regenerated copy.

alter table public.documents
  add column if not exists certified_file_path text;

drop policy if exists "documents_storage_select" on storage.objects;
create policy "documents_storage_select"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.documents d
        where (d.file_path = name or d.certified_file_path = name)
          and public.is_approver_on_document(d.id)
      )
      or public.current_user_role() = 'registrar'
    )
  );
