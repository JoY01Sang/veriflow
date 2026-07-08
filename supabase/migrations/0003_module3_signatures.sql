-- Module 3: Digital Signing and Verification

-- Public half of each user's signing key pair. Anyone authenticated can read
-- it, since a public key is exactly what's needed to verify a signature.
create table if not exists public.signing_public_keys (
  user_id uuid primary key references public.profiles (id),
  public_key_jwk jsonb not null,
  algorithm text not null default 'RSA-PSS-SHA256',
  created_at timestamptz not null default now()
);

alter table public.signing_public_keys enable row level security;

drop policy if exists "signing_public_keys_select_all" on public.signing_public_keys;
create policy "signing_public_keys_select_all"
  on public.signing_public_keys for select
  using (true);

-- No insert/update/delete policy: only the sign-approval-step Edge Function,
-- using the service role key, ever writes here.

-- Private half. RLS is enabled with NO policies at all, for any role except
-- service_role (which always bypasses RLS) -- this table is unreachable from
-- the anon/authenticated client no matter who's asking, including the key's
-- own owner. Only the Edge Function can read or write it.
create table if not exists public.signing_private_keys (
  user_id uuid primary key references public.profiles (id),
  private_key_jwk jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.signing_private_keys enable row level security;

-- One signature per approval step. Stores a snapshot of the public key used
-- (rather than joining signing_public_keys) so a later key rotation can
-- never change what an old signature verifies against.
create table if not exists public.signatures (
  id uuid primary key default gen_random_uuid(),
  approval_step_id uuid not null unique references public.approval_steps (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  signer_id uuid not null references public.profiles (id),
  document_hash text not null,
  signature_b64 text not null,
  algorithm text not null default 'RSA-PSS-SHA256',
  public_key_jwk jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.signatures enable row level security;

-- Visible to whoever can already see the parent document: its submitter,
-- any approver assigned a step on it, or an admin.
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
          or public.current_user_role() = 'admin'
        )
    )
  );

-- No insert/update/delete policy: only the sign-approval-step Edge Function
-- (service role) writes signatures, after it has independently verified the
-- caller is the assigned approver for a pending step.
