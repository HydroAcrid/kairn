create or replace view public.kairn_latest_installation_telemetry
with (security_invoker = true) as
select distinct on (installation_id)
  installation_id,
  schema_version,
  payload,
  received_at
from public.kairn_telemetry_events
where schema_version = 1
order by installation_id, received_at desc, id desc;

revoke all on public.kairn_latest_installation_telemetry from anon, authenticated;
grant select on public.kairn_latest_installation_telemetry to service_role;

create or replace view public.kairn_public_impact_summary
with (security_invoker = true) as
with latest as (
  select payload, received_at
  from public.kairn_latest_installation_telemetry
  where payload ? 'impact'
)
select
  count(*)::integer as active_installations,
  coalesce(sum((payload #>> '{impact,estimatedActiveSavedTokens}')::bigint), 0)::bigint as estimated_active_saved_tokens,
  coalesce(sum((payload #>> '{impact,estimatedPassiveSavedTokens}')::bigint), 0)::bigint as estimated_passive_saved_tokens,
  coalesce(sum((payload #>> '{impact,estimatedTotalSavedTokens}')::bigint), 0)::bigint as estimated_total_saved_tokens,
  coalesce(sum((payload #>> '{impact,repeatedFilesAvoided}')::bigint), 0)::bigint as repeated_files_avoided,
  coalesce(sum((payload #>> '{impact,repeatedSnippetsAvoided}')::bigint), 0)::bigint as repeated_snippets_avoided,
  coalesce(sum((payload #>> '{impact,quietDecisions}')::bigint), 0)::bigint as quiet_decisions,
  coalesce(sum((payload #>> '{impact,evidenceRequests}')::bigint), 0)::bigint as evidence_requests,
  coalesce(sum((payload #>> '{impact,usefulMcpCalls}')::bigint), 0)::bigint as useful_mcp_calls,
  coalesce(sum((payload #>> '{impact,hookInvocations}')::bigint), 0)::bigint as hook_invocations,
  coalesce(sum((payload #>> '{impact,hookFailures}')::bigint), 0)::bigint as hook_failures,
  coalesce(sum((payload #>> '{impact,scopeViolations}')::bigint), 0)::bigint as scope_violations,
  coalesce(sum((payload #>> '{impact,overAssistEvents}')::bigint), 0)::bigint as over_assist_events,
  coalesce(sum((payload #>> '{impact,missedOpportunityEvents}')::bigint), 0)::bigint as missed_opportunity_events,
  coalesce(sum((payload #>> '{impact,harmfulAssistEvents}')::bigint), 0)::bigint as harmful_assist_events,
  round(avg((payload #>> '{impact,averageHookLatencyMs}')::numeric))::integer as average_hook_latency_ms,
  max(received_at) as latest_received_at
from latest;

revoke all on public.kairn_public_impact_summary from anon, authenticated;
grant select on public.kairn_public_impact_summary to service_role;
