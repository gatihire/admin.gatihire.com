do $$
begin
  execute 'alter table jobs drop constraint if exists jobs_salary_type_chk';
  execute 'alter table jobs add constraint jobs_salary_type_chk check (salary_type is null or salary_type in (''monthly'',''annual'',''daily'',''per_trip'',''hourly''))';
end $$;
