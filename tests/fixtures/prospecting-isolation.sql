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
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"26300000-1111-4000-8000-000000000001","aal":"aal2"}',true);
do $$
begin
  if (select count(*) from prospecting_campaigns)<>1 then raise exception 'RLS leaked campaign'; end if;
  if exists(select 1 from prospecting_campaigns where name='TESTE B') then raise exception 'RLS leaked tenant B'; end if;
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
