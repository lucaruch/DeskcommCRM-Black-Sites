-- Dados exclusivamente sinteticos; rollback mantem o banco de teste limpo.
begin;
insert into organizations(id,slug,legal_name,display_name) values
 ('26300000-0000-4000-8000-000000000001','prospect-test-a','TESTE A','TESTE A'),
 ('26300000-0000-4000-8000-000000000002','prospect-test-b','TESTE B','TESTE B');
insert into auth.users(id,email) values
 ('26300000-1111-4000-8000-000000000001','a@prospecting.invalid'),
 ('26300000-1111-4000-8000-000000000002','b@prospecting.invalid');
insert into user_organizations(user_id,organization_id,role,accepted_at) values
 ('26300000-1111-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','admin',now()),
 ('26300000-1111-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','admin',now());
insert into crm_pipelines(id,organization_id,name,slug) values
 ('26300000-2222-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','TESTE A','prospect-test'),
 ('26300000-2222-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','TESTE B','prospect-test');
insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values
 ('26300000-3333-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','26300000-2222-4000-8000-000000000001','TESTE','novo',1000),
 ('26300000-3333-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','26300000-2222-4000-8000-000000000002','TESTE','novo',1000);
insert into prospecting_campaigns(id,organization_id,name,slug,pipeline_id,initial_stage_id,reply_stage_id) values
 ('26300000-4444-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','TESTE A','teste','26300000-2222-4000-8000-000000000001','26300000-3333-4000-8000-000000000001','26300000-3333-4000-8000-000000000001'),
 ('26300000-4444-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','TESTE B','teste','26300000-2222-4000-8000-000000000002','26300000-3333-4000-8000-000000000002','26300000-3333-4000-8000-000000000002');
insert into contacts(id,organization_id,display_name) values
 ('26300000-5555-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','TESTE CONTATO A'),
 ('26300000-5555-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','TESTE CONTATO B');
insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id) values
 ('26300000-6666-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','26300000-2222-4000-8000-000000000001','26300000-3333-4000-8000-000000000001','TESTE LEAD A','26300000-5555-4000-8000-000000000001'),
 ('26300000-6666-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','26300000-2222-4000-8000-000000000002','26300000-3333-4000-8000-000000000002','TESTE LEAD B','26300000-5555-4000-8000-000000000002');
insert into prospecting_recipients(id,organization_id,campaign_id,contact_id,lead_id,phone_number,company_key,status) values
 ('26300000-7777-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','26300000-4444-4000-8000-000000000001','26300000-5555-4000-8000-000000000001','26300000-6666-4000-8000-000000000001','+55000000001','teste-a','pending'),
 ('26300000-7777-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','26300000-4444-4000-8000-000000000002','26300000-5555-4000-8000-000000000002','26300000-6666-4000-8000-000000000002','+55000000002','teste-b','pending');
insert into prospecting_events(id,organization_id,campaign_id,recipient_id,type) values
 ('26300000-8888-4000-8000-000000000001','26300000-0000-4000-8000-000000000001','26300000-4444-4000-8000-000000000001','26300000-7777-4000-8000-000000000001','accepted'),
 ('26300000-8888-4000-8000-000000000002','26300000-0000-4000-8000-000000000002','26300000-4444-4000-8000-000000000002','26300000-7777-4000-8000-000000000002','accepted');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"26300000-1111-4000-8000-000000000001","aal":"aal2"}',true);
do $$
begin
  if (select count(*) from prospecting_campaigns)<>1 then raise exception 'RLS leaked campaign'; end if;
  if exists(select 1 from prospecting_campaigns where name='TESTE B') then raise exception 'RLS leaked tenant B'; end if;
  if (select count(*) from prospecting_recipients)<>1 then raise exception 'RLS leaked recipient'; end if;
  if exists(select 1 from prospecting_recipients where company_key='teste-b') then raise exception 'RLS leaked recipient tenant B'; end if;
  if (select count(*) from prospecting_events)<>1 then raise exception 'RLS leaked event'; end if;
  if exists(select 1 from prospecting_events where organization_id='26300000-0000-4000-8000-000000000002') then raise exception 'RLS leaked event tenant B'; end if;
end $$;
reset role;
do $$
begin
  begin
    insert into prospecting_campaigns(organization_id,name,slug,pipeline_id,initial_stage_id,reply_stage_id)
    values('26300000-0000-4000-8000-000000000001','INVALID','invalid','26300000-2222-4000-8000-000000000002','26300000-3333-4000-8000-000000000002','26300000-3333-4000-8000-000000000002');
    raise exception 'Cross tenant FK accepted';
  exception when foreign_key_violation then null;
  end;
end $$;
rollback;
