-- A dedicated column cannot be undone by Agent metadata upserts.
alter table public.colab_bridge_runtimes add column draining boolean not null default false;
alter table public.colab_bridge_lifecycle add column worker_token uuid;
-- Reuse aliases retain the allocation owner; provider credentials/resource identity stay there.
alter table public.colab_bridge_lifecycle add column allocation_owner_id uuid references public.colab_bridge_lifecycle(id);
alter table public.colab_bridge_lifecycle add column worker_expires_at timestamptz;
create table public.colab_bridge_lifecycle_requests (
 request_id uuid primary key, lifecycle_id uuid not null references public.colab_bridge_lifecycle(id), normalized jsonb not null
);
alter table public.colab_bridge_lifecycle_requests enable row level security;
revoke all on public.colab_bridge_lifecycle_requests from anon, authenticated;
grant all on public.colab_bridge_lifecycle_requests to service_role;

-- Serializes equivalent ensure calls and retains every caller's request-id binding.
create function public.colab_bridge_lifecycle_begin(p_request_id uuid,p_provider text,p_accelerator text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row public.colab_bridge_lifecycle%rowtype; v_alias public.colab_bridge_lifecycle_requests%rowtype;
 v_reuse uuid;
 v_owner uuid;
 v_norm jsonb:=jsonb_build_object('provider',p_provider,'accelerator',p_accelerator);
begin
 if p_provider not in ('google_colab','external') or p_accelerator !~ '^[A-Z][A-Z0-9_-]{0,31}$'
    or substr(p_request_id::text,15,1) <> '4' then return jsonb_build_object('ok',false,'error_code','INVALID_REQUEST'); end if;
 perform pg_advisory_xact_lock(hashtextextended('lifecycle-request:'||p_request_id::text,0));
 select * into v_alias from public.colab_bridge_lifecycle_requests where request_id=p_request_id;
 if found then
  if v_alias.normalized<>v_norm then return jsonb_build_object('ok',false,'error_code','IDEMPOTENCY_CONFLICT'); end if;
  select * into v_row from public.colab_bridge_lifecycle where id=v_alias.lifecycle_id;
  return jsonb_build_object('ok',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at','idempotent',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('lifecycle:'||p_provider||':'||p_accelerator,0));
 select * into v_row from public.colab_bridge_lifecycle
 where provider=p_provider and accelerator=p_accelerator and action in ('ensure','wake')
   and status in ('accepted','starting','bootstrapping','ready','blocked') and request->>'releasing' is distinct from 'true'
   and not exists(select 1 from public.colab_bridge_lifecycle owner
       where owner.id=colab_bridge_lifecycle.allocation_owner_id
         and (owner.status in ('failed','released') or owner.request->>'releasing'='true'))
 order by created_at limit 1;
 if not found then
  select r.runtime_id into v_reuse from public.colab_bridge_runtimes r
  where not r.draining and r.last_heartbeat_at between clock_timestamp()-interval '60 seconds' and clock_timestamp()+interval '5 seconds'
   and not exists(select 1 from public.colab_bridge_lifecycle gone
       where (gone.runtime_id=r.runtime_id or gone.request->>'expected_agent_id'=r.runtime_id::text)
         and gone.request->>'allocation_absent'='true')
   and r.accelerator='nvidia_gpu' and r.runtime_metadata->>'execution_enabled'='true'
   and exists(select 1 from public.colab_bridge_snapshots s where s.runtime_id=r.runtime_id and s.kind='gpu'
      and s.observed_at between clock_timestamp()-interval '60 seconds' and clock_timestamp()+interval '5 seconds'
      and s.payload->>'telemetry_available' is distinct from 'false' and exists(
        select 1 from jsonb_array_elements(case when jsonb_typeof(s.payload->'gpus')='array' then s.payload->'gpus' else '[]'::jsonb end) g
        where upper(g->>'name') ~ ('(^|[^A-Z0-9])'||p_accelerator||'([^A-Z0-9]|$)')
      )) order by r.last_heartbeat_at desc limit 1;
  select coalesce(owner.allocation_owner_id,owner.id) into v_owner
  from public.colab_bridge_lifecycle owner
  -- Registration may precede the owner's first ready poll/runtime_id association.
  where (owner.runtime_id=v_reuse or owner.request->>'expected_agent_id'=v_reuse::text)
    and (owner.allocation_owner_id is not null
    or owner.request->>'resource' is not null or owner.request->>'operation' is not null)
  order by owner.created_at limit 1;
  insert into public.colab_bridge_lifecycle(request_id,provider,action,accelerator,request,runtime_id,allocation_owner_id)
  values(p_request_id,p_provider,'ensure',p_accelerator,jsonb_build_object('expected_agent_id',coalesce(v_reuse,gen_random_uuid()),'reused_runtime',v_reuse is not null),v_reuse,v_owner) returning * into v_row;
 end if;
 insert into public.colab_bridge_lifecycle_requests values(p_request_id,v_row.id,v_norm);
 return jsonb_build_object('ok',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at');
end; $$;

-- Fences each bounded network/bootstrap advancement; tokens are never returned to MCP clients.
create function public.colab_bridge_lifecycle_acquire(p_id uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row public.colab_bridge_lifecycle%rowtype;
begin
 select * into v_row from public.colab_bridge_lifecycle where id=p_id for update;
 if not found then return jsonb_build_object('ok',false,'error_code','LIFECYCLE_NOT_FOUND'); end if;
 if v_row.worker_expires_at>clock_timestamp() then return jsonb_build_object('ok',true,'busy',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at'); end if;
 update public.colab_bridge_lifecycle set worker_token=gen_random_uuid(),worker_expires_at=clock_timestamp()+interval '180 seconds'
 where id=p_id returning * into v_row;
 return jsonb_build_object('ok',true,'token',v_row.worker_token,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at');
end; $$;
create function public.colab_bridge_lifecycle_save(p_id uuid,p_token uuid,p_status text,p_request jsonb,p_runtime_id uuid,p_error_code text,p_unlock boolean default true) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row public.colab_bridge_lifecycle%rowtype;
begin
 update public.colab_bridge_lifecycle set status=case when request->>'releasing'='true' and p_request->>'releasing' is distinct from 'true' then 'starting' else p_status end,
 request=request||p_request||case when request->>'releasing'='true' then jsonb_build_object('releasing',true,'cancel_jobs',request->'cancel_jobs') else '{}'::jsonb end,
 runtime_id=coalesce(p_runtime_id,runtime_id),error_code=p_error_code,
 action=case when request->>'releasing'='true' or p_request->>'releasing'='true' then 'release' else action end,
 updated_at=clock_timestamp(), completed_at=case when p_status in ('released','failed') then clock_timestamp() else null end,
 worker_token=case when p_unlock then null else worker_token end,worker_expires_at=case when p_unlock then null else worker_expires_at end
 where id=p_id and worker_token=p_token and worker_expires_at>clock_timestamp() returning * into v_row;
 if not found then return jsonb_build_object('ok',false,'error_code','LIFECYCLE_LEASE_LOST'); end if;
 return jsonb_build_object('ok',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at');
end; $$;

-- Release shares claim's runtime lock. Running audit/leases stay intact until terminal.
create function public.colab_bridge_begin_release(p_runtime_id uuid,p_cancel_jobs boolean default false,p_create_placeholder boolean default false) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job record;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_runtime_id::text,0));
 if p_create_placeholder then
  insert into public.colab_bridge_runtimes(runtime_id,label,draining,last_heartbeat_at) values(p_runtime_id,'releasing-runtime',true,'epoch') on conflict(runtime_id) do nothing;
 end if;
 if not exists(select 1 from public.colab_bridge_runtimes where runtime_id=p_runtime_id) then return jsonb_build_object('ok',false,'error_code','NO_RUNTIME'); end if;
 perform public.colab_bridge_reap_expired_jobs();
 if not p_cancel_jobs and exists(select 1 from public.colab_bridge_jobs where
   (runtime_id=p_runtime_id and status in ('running','cancelling')) or (requested_runtime_id=p_runtime_id and status='queued')) then
  return jsonb_build_object('ok',false,'error_code','ACTIVE_JOBS');
 end if;
 update public.colab_bridge_runtimes set draining=true where runtime_id=p_runtime_id;
 if p_cancel_jobs then
  for v_job in select id from public.colab_bridge_jobs where
    (runtime_id=p_runtime_id and status in ('running','cancelling')) or (requested_runtime_id=p_runtime_id and status='queued')
  loop perform public.colab_bridge_cancel_job(v_job.id); end loop;
 end if;
 return jsonb_build_object('ok',true,'draining',true,'can_delete',not exists(select 1 from public.colab_bridge_jobs where runtime_id=p_runtime_id and status in ('running','cancelling')));
end; $$;

-- Safe merge only known execution/version metadata; draining is a separate protected column.
create function public.colab_bridge_agent_heartbeat(p_runtime_id uuid,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update public.colab_bridge_runtimes set last_heartbeat_at=clock_timestamp(),
 accelerator=case when jsonb_typeof(p_payload->'accelerator')='string' then p_payload->>'accelerator' else accelerator end,
 runtime_metadata=runtime_metadata ||
  case when jsonb_typeof(p_payload->'execution_enabled')='boolean' then jsonb_build_object('execution_enabled',p_payload->'execution_enabled') else '{}'::jsonb end ||
  case when jsonb_typeof(p_payload->'agent_version')='string' then jsonb_build_object('agent_version',p_payload->'agent_version') else '{}'::jsonb end
 where runtime_id=p_runtime_id;
 if not found then return jsonb_build_object('ok',false,'error_code','NO_RUNTIME'); end if;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.colab_bridge_claim_job(p_runtime_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_runtime public.colab_bridge_runtimes%rowtype;
  v_job public.colab_bridge_jobs%rowtype;
  v_token uuid;
  v_restore jsonb;
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_runtime_id::text, 0));
  select * into v_runtime from public.colab_bridge_runtimes
    where runtime_id = p_runtime_id for update;
  if not found then return jsonb_build_object('ok', false, 'error_code', 'NO_RUNTIME'); end if;

  perform public.colab_bridge_reap_expired_jobs();

  if v_runtime.draining then return jsonb_build_object('ok', true, 'job', null); end if;
  if v_runtime.runtime_metadata ->> 'execution_enabled' is distinct from 'true' then
    return jsonb_build_object('ok', true, 'job', null);
  end if;
  if exists (
    select 1 from public.colab_bridge_jobs
    where runtime_id = p_runtime_id and status in ('running', 'cancelling')
  ) then
    return jsonb_build_object('ok', true, 'job', null);
  end if;

  select j.* into v_job
  from public.colab_bridge_jobs j
  where status = 'queued'
    and (requested_runtime_id is null or requested_runtime_id = p_runtime_id)
    and (not require_gpu or v_runtime.accelerator = 'nvidia_gpu')
  order by created_at
  for update skip locked
  limit 1;
  if not found then return jsonb_build_object('ok', true, 'job', null); end if;

  v_now := clock_timestamp();
  v_token := gen_random_uuid();
  update public.colab_bridge_jobs
    set status = 'running', runtime_id = p_runtime_id, lease_token = v_token,
        lease_expires_at = v_now + interval '60 seconds',
        started_at = coalesce(started_at, v_now), updated_at = v_now
    where id = v_job.id
    returning * into v_job;

  if v_job.parent_job_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'path', a.path, 'bytes', a.bytes, 'sha256', a.sha256,
      'mime_type', a.mime_type, 'storage_path', a.storage_path
    ) order by a.created_at), '[]'::jsonb)
      into v_restore
    from public.colab_bridge_artifacts a
    where a.job_id = v_job.parent_job_id and a.status = 'published';
  end if;

  return jsonb_build_object('ok', true, 'job', jsonb_strip_nulls(jsonb_build_object(
    'id', v_job.id,
    'kind', v_job.kind,
    'spec', v_job.spec,
    'project', v_job.project,
    'timeout_seconds', v_job.timeout_seconds,
    'attempt', v_job.attempt,
    'lease_token', v_job.lease_token,
    'restore_artifacts', v_restore
  )));
end;
$$;


drop function public.colab_bridge_retry_job(uuid,text);
create function public.colab_bridge_retry_job(p_job_id uuid, p_idempotency_key text, p_checkpoint_path text default null) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source public.colab_bridge_jobs%rowtype;
  v_job public.colab_bridge_jobs%rowtype;
  v_hash text;
  v_spec jsonb;
  v_marker text;
  v_requested_runtime_id uuid;
begin
  if length(p_idempotency_key) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_JOB');
  end if;
  -- Admission lock precedes every job-row lock (including lease reaping), as in claim/release.
  select * into v_source from public.colab_bridge_jobs where id=p_job_id;
  if not found then return jsonb_build_object('ok',false,'error_code','JOB_NOT_FOUND'); end if;
  v_requested_runtime_id:=v_source.requested_runtime_id;
  if v_requested_runtime_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_requested_runtime_id::text,0));
    if exists(select 1 from public.colab_bridge_runtimes where runtime_id=v_requested_runtime_id and draining) then
      return jsonb_build_object('ok',false,'error_code','RUNTIME_DRAINING');
    end if;
  end if;
  perform public.colab_bridge_reap_expired_jobs();
  select * into v_source from public.colab_bridge_jobs where id = p_job_id for update;
  if v_source.requested_runtime_id is distinct from v_requested_runtime_id then
    return jsonb_build_object('ok',false,'error_code','RUNTIME_AFFINITY_CHANGED');
  end if;
  if not found then return jsonb_build_object('ok', false, 'error_code', 'JOB_NOT_FOUND'); end if;
  if v_source.status not in ('succeeded', 'failed', 'cancelled', 'timed_out', 'lost') then
    return jsonb_build_object('ok', false, 'error_code', 'JOB_NOT_TERMINAL');
  end if;
  v_spec := v_source.spec;
  if p_checkpoint_path is not null then
    if v_source.kind not in ('pipeline','lora') or length(p_checkpoint_path) not between 1 and 512
       or p_checkpoint_path ~ '(^/|\\|(^|/)\.\.?(/|$)|/$|//)' then
      return jsonb_build_object('ok',false,'error_code','CHECKPOINT_INVALID');
    end if;
    v_marker := case when v_source.kind='lora' then p_checkpoint_path || '/checkpoint.json' else p_checkpoint_path end;
    if v_marker !~ '(^|/)checkpoint[.]json$' or not exists (
      select 1 from public.colab_bridge_artifacts where job_id=v_source.id and path=v_marker and status='published'
    ) then return jsonb_build_object('ok',false,'error_code','CHECKPOINT_INVALID'); end if;
    v_spec := v_spec || jsonb_build_object('checkpoint_path',p_checkpoint_path);
    if v_source.kind='pipeline' then v_spec := v_spec || '{"resume":true}'::jsonb; end if;
  end if;
  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_source.id::text || ':' || p_idempotency_key || ':' || coalesce(p_checkpoint_path,''), 'UTF8')),
    'hex'
  );
  begin
    insert into public.colab_bridge_jobs (
      kind, spec, project, timeout_seconds, requested_runtime_id, require_gpu,
      idempotency_key, request_hash, attempt, parent_job_id
    ) values (
      v_source.kind, v_spec, v_source.project, v_source.timeout_seconds,
      v_source.requested_runtime_id, v_source.require_gpu, p_idempotency_key, v_hash,
      v_source.attempt + 1, v_source.id
    ) returning * into v_job;
  exception when unique_violation then
    select * into v_job from public.colab_bridge_jobs where idempotency_key = p_idempotency_key;
    if not found or v_job.parent_job_id is distinct from v_source.id or v_job.spec is distinct from v_spec then
      return jsonb_build_object('ok', false, 'error_code', 'IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status, 'idempotent', true);
  end;
  return jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status, 'idempotent', false);
end;
$$;


revoke all on function public.colab_bridge_lifecycle_begin(uuid,text,text) from public, anon, authenticated;
grant execute on function public.colab_bridge_lifecycle_begin(uuid,text,text) to service_role;

revoke all on function public.colab_bridge_lifecycle_acquire(uuid) from public, anon, authenticated;
grant execute on function public.colab_bridge_lifecycle_acquire(uuid) to service_role;

revoke all on function public.colab_bridge_lifecycle_save(uuid,uuid,text,jsonb,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.colab_bridge_lifecycle_save(uuid,uuid,text,jsonb,uuid,text,boolean) to service_role;

revoke all on function public.colab_bridge_begin_release(uuid,boolean,boolean) from public, anon, authenticated;
grant execute on function public.colab_bridge_begin_release(uuid,boolean,boolean) to service_role;

revoke all on function public.colab_bridge_agent_heartbeat(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.colab_bridge_agent_heartbeat(uuid,jsonb) to service_role;

revoke all on function public.colab_bridge_retry_job(uuid,text,text) from public, anon, authenticated;
grant execute on function public.colab_bridge_retry_job(uuid,text,text) to service_role;

create or replace function public.colab_bridge_submit_job(
  p_kind text,
  p_spec jsonb,
  p_project text,
  p_timeout_seconds integer,
  p_runtime_id uuid,
  p_require_gpu boolean,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.colab_bridge_jobs%rowtype;
begin
  if p_runtime_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_runtime_id::text,0));
    if exists(select 1 from public.colab_bridge_runtimes where runtime_id=p_runtime_id and draining) then
      return jsonb_build_object('ok',false,'error_code','RUNTIME_DRAINING');
    end if;
  end if;
  if p_kind not in ('python', 'shell', 'pip', 'git', 'model_download', 'benchmark', 'lora', 'export', 'file', 'drive_export', 'pipeline')
    or jsonb_typeof(p_spec) is distinct from 'object'
    or p_project !~ '^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$'
    or p_timeout_seconds not between 1 and 3600
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or (p_idempotency_key is not null and length(p_idempotency_key) not between 1 and 200)
  then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_JOB');
  end if;

  begin
    insert into public.colab_bridge_jobs (
      kind, spec, project, timeout_seconds, requested_runtime_id, require_gpu,
      idempotency_key, request_hash
    ) values (
      p_kind, p_spec, p_project, p_timeout_seconds, p_runtime_id, p_require_gpu,
      p_idempotency_key, p_request_hash
    ) returning * into v_job;
  exception when unique_violation then
    if p_idempotency_key is null then raise; end if;
    select * into v_job from public.colab_bridge_jobs where idempotency_key = p_idempotency_key;
    if not found or v_job.request_hash <> p_request_hash then
      return jsonb_build_object('ok', false, 'error_code', 'IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status, 'idempotent', true);
  end;

  return jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status, 'idempotent', false);
end;
$$;


-- Release intent is durable even while a provider request is in flight under a worker lease.
create function public.colab_bridge_request_release(p_id uuid,p_cancel_jobs boolean default false) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row public.colab_bridge_lifecycle%rowtype; v_check jsonb; v_owner uuid;
begin
 -- Resolve immutable ownership before taking the owner lock; never lock alias then owner.
 select coalesce(allocation_owner_id,id) into v_owner from public.colab_bridge_lifecycle where id=p_id;
 select * into v_row from public.colab_bridge_lifecycle where id=v_owner for update;
 if not found then return jsonb_build_object('ok',false,'error_code','LIFECYCLE_NOT_FOUND'); end if;
 if v_row.status='released' then return jsonb_build_object('ok',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at'); end if;
 if v_row.request->>'reused_runtime'='true' and v_row.request->>'resource' is null then return jsonb_build_object('ok',false,'error_code','PROVIDER_RESOURCE_UNKNOWN'); end if;
 v_check:=public.colab_bridge_begin_release((v_row.request->>'expected_agent_id')::uuid,p_cancel_jobs or coalesce((v_row.request->>'cancel_jobs')::boolean,false),true);
 if v_check->>'ok'<>'true' then return v_check; end if;
 update public.colab_bridge_lifecycle set action='release',status='starting',
 runtime_id=(request->>'expected_agent_id')::uuid,
 request=request||jsonb_build_object('releasing',true,'cancel_jobs',p_cancel_jobs or coalesce((request->>'cancel_jobs')::boolean,false)),
 updated_at=clock_timestamp() where id=v_owner returning * into v_row;
 return jsonb_build_object('ok',true,'lifecycle',to_jsonb(v_row)-'worker_token'-'worker_expires_at');
end; $$;
revoke all on function public.colab_bridge_request_release(uuid,boolean) from public,anon,authenticated;
grant execute on function public.colab_bridge_request_release(uuid,boolean) to service_role;
