-- Module 4: Audit Trail and Reporting

create extension if not exists pgcrypto;

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  event_type text not null,
  actor_id uuid references public.profiles (id),
  document_id uuid references public.documents (id),
  approval_step_id uuid references public.approval_steps (id),
  metadata jsonb not null default '{}'::jsonb,
  prev_hash text,
  entry_hash text not null default '',
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

-- Visible to admins (everything), the actor themselves, or anyone who can
-- already see the related document (its submitter or an assigned approver).
drop policy if exists "audit_log_select" on public.audit_log;
create policy "audit_log_select"
  on public.audit_log for select
  using (
    public.current_user_role() = 'admin'
    or actor_id = auth.uid()
    or (
      document_id is not null
      and exists (
        select 1 from public.documents d
        where d.id = audit_log.document_id
          and (
            d.submitter_id = auth.uid()
            or exists (
              select 1 from public.approval_steps s
              where s.document_id = d.id and s.approver_id = auth.uid()
            )
          )
      )
    )
  );

-- No insert/update/delete policy for any client role: every row is written
-- by a SECURITY DEFINER function/trigger (insert_audit_log, the signing
-- Edge Function's service-role client) or the hash-chain trigger itself.
-- Nothing can forge or edit an entry directly through the API.

-- Each new row's hash covers its own content plus the previous row's hash,
-- so altering or deleting any past entry breaks every hash after it --
-- verify_audit_chain() (below) detects exactly that.
create or replace function public.compute_audit_hash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_hash text;
begin
  select entry_hash into v_prev_hash from public.audit_log order by seq desc limit 1;

  new.prev_hash := v_prev_hash;
  new.entry_hash := encode(
    digest(
      coalesce(v_prev_hash, 'GENESIS') || '|' ||
      new.seq::text || '|' ||
      new.event_type || '|' ||
      coalesce(new.actor_id::text, '') || '|' ||
      coalesce(new.document_id::text, '') || '|' ||
      coalesce(new.approval_step_id::text, '') || '|' ||
      coalesce(new.metadata::text, '{}') || '|' ||
      new.created_at::text,
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$;

drop trigger if exists audit_log_hash_chain on public.audit_log;
create trigger audit_log_hash_chain
  before insert on public.audit_log
  for each row execute function public.compute_audit_hash();

-- Internal helper: not granted to authenticated/anon. Only callable from
-- other functions owned by the same role (handle_new_user,
-- log_document_submitted, act_on_approval_step, log_audit_event below).
create or replace function public.insert_audit_log(
  p_event_type text,
  p_actor_id uuid,
  p_document_id uuid,
  p_approval_step_id uuid,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (event_type, actor_id, document_id, approval_step_id, metadata)
  values (p_event_type, p_actor_id, p_document_id, p_approval_step_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. This
-- function trusts its arguments completely (no internal auth check), so
-- that default would let any authenticated client call it directly and
-- forge an audit entry under someone else's name. Lock it down to the
-- handful of trusted server-side callers: other SECURITY DEFINER functions
-- owned by the same role (which can call it regardless of grants, via
-- ownership), and the signing Edge Function's service-role client.
revoke execute on function public.insert_audit_log(text, uuid, uuid, uuid, jsonb) from public;
grant execute on function public.insert_audit_log(text, uuid, uuid, uuid, jsonb) to service_role;

-- The only audit events a client can log directly, and only as themselves.
-- Workflow events (submission, approval, signing) are always logged
-- server-side as a side effect of the action itself, never via this RPC.
create or replace function public.log_audit_event(p_event_type text, p_document_id uuid default null, p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event_type not in ('user_login', 'document_viewed') then
    raise exception 'event type % cannot be logged directly by a client', p_event_type;
  end if;

  perform public.insert_audit_log(p_event_type, auth.uid(), p_document_id, null, p_metadata);
end;
$$;

grant execute on function public.log_audit_event(text, uuid, jsonb) to authenticated;

-- Admin-only: recompute the hash chain and report any entry whose hash (or
-- link to the previous entry) no longer matches -- evidence of tampering.
create or replace function public.verify_audit_chain()
returns table (broken_seq bigint, reason text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'only admins can verify the audit chain';
  end if;

  return query
  with ordered as (
    select
      a.seq, a.event_type, a.actor_id, a.document_id, a.approval_step_id,
      a.metadata, a.created_at, a.prev_hash, a.entry_hash,
      lag(a.entry_hash) over (order by a.seq) as actual_prev_entry_hash
    from public.audit_log a
  )
  select
    o.seq,
    case
      when coalesce(o.prev_hash, 'GENESIS') is distinct from coalesce(o.actual_prev_entry_hash, 'GENESIS')
        then 'prev_hash does not match the preceding entry'
      when o.entry_hash <> encode(
        digest(
          coalesce(o.prev_hash, 'GENESIS') || '|' ||
          o.seq::text || '|' || o.event_type || '|' ||
          coalesce(o.actor_id::text, '') || '|' ||
          coalesce(o.document_id::text, '') || '|' ||
          coalesce(o.approval_step_id::text, '') || '|' ||
          coalesce(o.metadata::text, '{}') || '|' ||
          o.created_at::text,
          'sha256'
        ),
        'hex'
      ) then 'entry_hash does not match the recomputed hash'
      else null
    end as reason
  from ordered o
  where (
    coalesce(o.prev_hash, 'GENESIS') is distinct from coalesce(o.actual_prev_entry_hash, 'GENESIS')
    or o.entry_hash <> encode(
      digest(
        coalesce(o.prev_hash, 'GENESIS') || '|' ||
        o.seq::text || '|' || o.event_type || '|' ||
        coalesce(o.actor_id::text, '') || '|' ||
        coalesce(o.document_id::text, '') || '|' ||
        coalesce(o.approval_step_id::text, '') || '|' ||
        coalesce(o.metadata::text, '{}') || '|' ||
        o.created_at::text,
        'sha256'
      ),
      'hex'
    )
  )
  order by o.seq;
end;
$$;

grant execute on function public.verify_audit_chain() to authenticated;

alter publication supabase_realtime add table public.audit_log;
