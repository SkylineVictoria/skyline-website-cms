-- NULL legacy ownership remains unresolved. Assigned applications must retain
-- an explicit agency/tenant relationship even if that relationship is disabled.
alter table public.enrollment_applications add constraint enrollment_applications_agency_tenant_parent
foreign key(agency_id,tenant_id) references public.agency_tenants(agency_id,tenant_id);
create index enrollment_applications_agency_tenant_idx on public.enrollment_applications(agency_id,tenant_id);
