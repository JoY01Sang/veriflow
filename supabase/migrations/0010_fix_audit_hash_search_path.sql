-- Module 4 (fix): compute_audit_hash() and verify_audit_chain() call pgcrypto's
-- digest(), but both functions set search_path = public only. On Supabase,
-- pgcrypto installs into the extensions schema, not public, so digest() was
-- unresolvable and every audit_log insert failed with
-- "function digest(text, unknown) does not exist". Adding extensions to the
-- search path fixes both without changing their logic.

alter function public.compute_audit_hash() set search_path = public, extensions;
alter function public.verify_audit_chain() set search_path = public, extensions;
